# `nimbus decisions` Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship `nimbus decisions`, a read-only agent that recovers decisions buried in indexed Slack/Notion/Confluence/Linear/Jira threads, corroborates them against PRs and migrations in the relationship graph, and returns a chronological list with deterministic confidence scores and evidence links.

**Architecture:** Two phases, copying `glossary` exactly. A debounced post-sync pass mines cue phrases (pure SQL + regex), asks a local LLM to veto or structure each candidate, then corroborates against the graph — writing to three new V47 tables. A read-only agent then does a pure `SELECT`; the read path never calls a model.

**Tech Stack:** Bun 1.2+, TypeScript 6.x strict, `bun:sqlite`, Biome, `bun:test`.

**Spec:** [`docs/superpowers/specs/2026-08-01-nimbus-decisions-design.md`](../specs/2026-08-01-nimbus-decisions-design.md) — read it before Task 1. The review that shaped it is in the same directory, `-design-review.md`.

## Global Constraints

These apply to **every** task. They are project non-negotiables, not preferences.

- **No `any`.** Use `unknown` for external data. TypeScript strict mode. External JSON is validated, never cast blind.
- **All SQLite writes go through `dbRun` / `dbExec` / `dbStmtRun`** from `packages/gateway/src/db/write.ts` (invariant **I14**, statically enforced by `scripts/structure-audit/check-nimbus-invariants.ts`). A raw `db.run(...)` fails the preflight. Reads may use `db.query(...)`.
- **Bound parameters only** (invariant **I9**). Never string-interpolate a value into SQL.
- **Never call `db.prepare()`** without `finalize()` — an unfinalized statement makes `db.close()` a silent no-op and pins the file, producing `EBUSY` on Windows. Use `db.query()`, which is safe.
- **The agent stays read-only.** `agents/decisions.ts` must not import `ToolExecutor` and must not reference `HITL_REQUIRED`. No `connectors.dispatch`. Task 16 asserts this structurally.
- **Cross-platform paths** — `path.join()` / `os.tmpdir()`, never hardcoded separators.
- **Prefer dependency injection over `mock.module`.** `mock.module` leaks process-globally and is a known CI-Linux-only failure mode in this repo. Every LLM in this plan is injected.
- **Commit on the branch `dev/asafgolombek/nimbus-decisions`** inside the worktree `.claude/worktrees/nimbus-decisions`. Never on `main`.
- **Read/Edit must use the worktree absolute path.** A main-repo path silently edits `main` instead.
- **Run `bun install` in the worktree before the first build** if `node_modules` is absent — a missing install produces fake failures that look like broken code.
- **`git commit -m` in bash command-substitutes backticked text out of the message.** Use `git commit -F -` with a quoted heredoc when the message contains backticks.

---

## File Structure

**New subsystem — `packages/gateway/src/decisions/`**

| File | Responsibility |
| --- | --- |
| `decision-types.ts` | `DecisionRecord`, `DecisionEvidence`, status/tier/kind unions. No logic. |
| `decision-source-types.ts` | `DECISION_SOURCE_TYPES` + `decisionSourceFilter()`. |
| `cue-mining.ts` | Sentence splitting, normalisation, cue matching, row id derivation. Pure — no DB. |
| `decision-confidence.ts` | `computePriority()` and `computeConfidence()`. Pure — no DB. |
| `decision-store.ts` | All reads/writes over the three V47 tables. |
| `decision-corroborate.ts` | Graph traversal → evidence rows. |
| `decision-service-scope.ts` | `--service` resolution: repository route + ticket-key route. |
| `decision-llm-adapter.ts` | Prompt construction + response parsing. |
| `decision-extract.ts` | The pass: discover → extract → corroborate; plus `rebuildDecisions`. |
| `decision-refresh.ts` | Debounced refresher. |

**Elsewhere**

| File | Change |
| --- | --- |
| `packages/gateway/src/index/decisions-v47-sql.ts` | Create — the migration SQL |
| `packages/gateway/src/index/migrations/runner.ts` | Modify — register step 46→47 |
| `packages/gateway/src/index/migrations/runner-v47.test.ts` | Create |
| `packages/gateway/src/config/nimbus-toml-decisions.ts` | Create — `[decisions]` parsing |
| `packages/gateway/src/agents/_lib/decisions-types.ts` | Create — `DecisionsBrief` (local, following `glossary-types.ts`, **not** the SDK) |
| `packages/gateway/src/agents/_lib/emit-brief.ts` | Modify — add to the `AnyBrief` union |
| `packages/gateway/src/agents/_lib/synthesize.ts` | Modify — 2 dispatch lines |
| `packages/gateway/src/agents/_lib/render.ts` | Modify — add `renderDecisions` |
| `packages/gateway/src/agents/decisions.ts` | Create — the agent |
| `packages/gateway/src/ipc/agents-rpc.ts` | Modify — `agents.decisions` |
| `packages/gateway/src/platform/assemble.ts` | Modify — wire the refresher |
| `packages/ui/src-tauri/src/gateway_bridge.rs` | Modify — allowlist entry + count 102→103 |
| `packages/cli/src/lib/parse-duration.ts` | Modify — add `d` and `w` units |
| `packages/cli/src/commands/decisions.ts` | Create — the CLI command |
| `packages/cli/src/index.ts` | Modify — register `decisions` |
| `packages/gateway/test/e2e/scenarios/decisions.e2e.test.ts` | Create |

---

## Task 1: V47 migration

**Files:**
- Create: `packages/gateway/src/index/decisions-v47-sql.ts`
- Modify: `packages/gateway/src/index/migrations/runner.ts` (import block ~line 28; step array ends ~line 428)
- Test: `packages/gateway/src/index/migrations/runner-v47.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `DECISIONS_V47_SQL: string`. Tables `decision_record`, `decision_evidence`, `decision_pass_state`.

- [ ] **Step 1: Write the failing test**

Create `packages/gateway/src/index/migrations/runner-v47.test.ts`. Model it on the existing `runner-v45.test.ts` — open it first to copy the exact harness helper it uses to build a migrated database, since that helper is the project's convention and this plan must not invent a second one.

```typescript
import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";

import { runMigrations } from "./runner.ts";

function migrated(): Database {
  const db = new Database(":memory:");
  runMigrations(db);
  return db;
}

test("V47 creates decision_record, decision_evidence and decision_pass_state", () => {
  const db = migrated();
  const names = db
    .query(
      `SELECT name FROM sqlite_master WHERE type='table'
        AND name IN ('decision_record','decision_evidence','decision_pass_state')
       ORDER BY name`,
    )
    .all() as Array<{ name: string }>;
  expect(names.map((r) => r.name)).toEqual([
    "decision_evidence",
    "decision_pass_state",
    "decision_record",
  ]);
  db.close();
});

test("V47 decision_record rejects an unknown status", () => {
  const db = migrated();
  expect(() =>
    db.run(
      `INSERT INTO decision_record
         (id, source_item_id, status, cue_tier, cue_text, decided_at, updated_at)
       VALUES ('d1','i1','bogus','weak','we decided',1,1)`,
    ),
  ).toThrow();
  db.close();
});

test("V47 decision_record rejects an unknown cue_tier", () => {
  const db = migrated();
  expect(() =>
    db.run(
      `INSERT INTO decision_record
         (id, source_item_id, status, cue_tier, cue_text, decided_at, updated_at)
       VALUES ('d1','i1','pending','shouty','we decided',1,1)`,
    ),
  ).toThrow();
  db.close();
});

test("V47 decision_evidence cascades when its decision is deleted", () => {
  const db = migrated();
  db.run("PRAGMA foreign_keys = ON");
  db.run(
    `INSERT INTO decision_record
       (id, source_item_id, status, cue_tier, cue_text, decided_at, updated_at)
     VALUES ('d1','i1','extracted','heading','Decision:',1,1)`,
  );
  db.run(
    `INSERT INTO decision_evidence (decision_id, kind, label)
     VALUES ('d1','pr','#412')`,
  );
  db.run("DELETE FROM decision_record WHERE id = 'd1'");
  const left = db.query("SELECT COUNT(*) AS n FROM decision_evidence").get() as { n: number };
  expect(left.n).toBe(0);
  db.close();
});

test("V47 decision_pass_state is single-row", () => {
  const db = migrated();
  db.run("INSERT INTO decision_pass_state (id) VALUES (1)");
  expect(() => db.run("INSERT INTO decision_pass_state (id) VALUES (2)")).toThrow();
  db.close();
});

test("V47 is idempotent across a second migration run", () => {
  const db = migrated();
  expect(() => runMigrations(db)).not.toThrow();
  db.close();
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
bun test packages/gateway/src/index/migrations/runner-v47.test.ts
```

Expected: FAIL — the three tables do not exist.

- [ ] **Step 3: Write the migration SQL**

Create `packages/gateway/src/index/decisions-v47-sql.ts`:

```typescript
/**
 * V47 — decision_record + decision_evidence + decision_pass_state
 * (implicit ADR extractor, Spine S1).
 *
 * `decision_record.id` is content-derived: hash(source_item_id, normalized cue
 * sentence). It is deliberately NOT positional. Keying on the cue's character
 * offset would mean a typo fix earlier in a document re-hashes every later cue,
 * re-queueing extracted rows AND resurrecting `vetoed` ones under new ids —
 * which would defeat the whole reason this table has no foreign key.
 *
 * `source_item_id` carries NO foreign key on purpose. `vetoed` rows are the
 * durable record of model calls already spent; cascading them away on an index
 * reset would re-burn the extraction budget on candidates already rejected. The
 * reconciliation sweep demotes rows whose source is gone instead.
 * `decision_evidence` DOES cascade — it is derived, cheap to recompute, and
 * meaningless without its parent.
 *
 * `priority` and `confidence` are two different numbers on purpose. `priority`
 * is knowable before the model runs (cue strength + source authority) and
 * orders the extraction queue. `confidence` needs corroboration and
 * completeness, so it is 0 for every pending row and must never be used to
 * order that queue.
 *
 * `decided_at` is a CONTENT date — the source item's `modified_at` — never a
 * row timestamp.
 *
 * `decision_pass_state` carries a COMPOSITE cursor. `watermark_ms` alone cannot
 * express "resume inside a group of items sharing one `modified_at`", and a
 * bulk import stamping thousands of rows with one job-level timestamp makes
 * that ordinary. `watermark_id` breaks the tie on `item.id`, a primary key and
 * therefore total.
 */
export const DECISIONS_V47_SQL = `
CREATE TABLE IF NOT EXISTS decision_record (
  id                TEXT PRIMARY KEY,
  source_item_id    TEXT NOT NULL,
  status            TEXT NOT NULL CHECK(status IN ('pending','extracted','vetoed')),
  statement         TEXT,
  rationale         TEXT,
  alternatives      TEXT NOT NULL DEFAULT '[]',
  extraction_source TEXT CHECK(extraction_source IN ('llm','snippet')),
  cue_tier          TEXT NOT NULL CHECK(cue_tier IN ('heading','explicit','weak')),
  cue_text          TEXT NOT NULL,
  priority          REAL NOT NULL DEFAULT 0,
  confidence        REAL NOT NULL DEFAULT 0,
  decided_at        INTEGER NOT NULL,
  has_adr           INTEGER NOT NULL DEFAULT 0,
  stats_verified_at INTEGER NOT NULL DEFAULT 0,
  attempts          INTEGER NOT NULL DEFAULT 0,
  last_attempt_at   INTEGER NOT NULL DEFAULT 0,
  updated_at        INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_decision_status_confidence
  ON decision_record(status, confidence DESC);
CREATE INDEX IF NOT EXISTS idx_decision_pending_priority
  ON decision_record(status, priority DESC, last_attempt_at);
CREATE INDEX IF NOT EXISTS idx_decision_decided_at
  ON decision_record(status, decided_at DESC);
CREATE INDEX IF NOT EXISTS idx_decision_verified
  ON decision_record(status, stats_verified_at);
CREATE INDEX IF NOT EXISTS idx_decision_source_item
  ON decision_record(source_item_id);

CREATE TABLE IF NOT EXISTS decision_evidence (
  decision_id  TEXT NOT NULL REFERENCES decision_record(id) ON DELETE CASCADE,
  kind         TEXT NOT NULL CHECK(kind IN ('source','pr','commit','migration','iac','adr')),
  entity_id    TEXT,
  item_id      TEXT,
  label        TEXT NOT NULL,
  url          TEXT,
  occurred_at  INTEGER,
  PRIMARY KEY (decision_id, kind, label)
);

CREATE INDEX IF NOT EXISTS idx_decision_evidence_decision
  ON decision_evidence(decision_id);

CREATE TABLE IF NOT EXISTS decision_pass_state (
  id            INTEGER PRIMARY KEY CHECK(id = 1),
  watermark_ms  INTEGER NOT NULL DEFAULT 0,
  watermark_id  TEXT    NOT NULL DEFAULT '',
  last_pass_at  INTEGER,
  last_pass_new INTEGER NOT NULL DEFAULT 0,
  scanned_items INTEGER NOT NULL DEFAULT 0
);
`;
```

- [ ] **Step 4: Register the migration step**

In `packages/gateway/src/index/migrations/runner.ts`, add the import beside the existing glossary imports (~line 28, keep alphabetical order within that block):

```typescript
import { DECISIONS_V47_SQL } from "../decisions-v47-sql.ts";
```

Then append to the end of the migration step array, immediately after the `45, 46` glossary-manual step:

```typescript
  simpleStep(
    46,
    47,
    "decision_record + decision_evidence + decision_pass_state (implicit ADR extractor v47)",
    DECISIONS_V47_SQL,
  ),
```

- [ ] **Step 5: Run the test to verify it passes**

```bash
bun test packages/gateway/src/index/migrations/runner-v47.test.ts
```

Expected: PASS, 6 tests.

- [ ] **Step 6: Run the full migration suite for regressions**

```bash
bun test packages/gateway/src/index/migrations/
```

Expected: PASS. A failure here means the version gate or the ledger disagrees about the new head version — read `runner.test.ts` for what it asserts about the latest version before changing anything.

- [ ] **Step 7: Commit**

```bash
git add packages/gateway/src/index/decisions-v47-sql.ts \
        packages/gateway/src/index/migrations/runner.ts \
        packages/gateway/src/index/migrations/runner-v47.test.ts
git commit -m "feat(decisions): add V47 decision_record, decision_evidence, decision_pass_state"
```

---

## Task 2: Types and the source-type allowlist

**Files:**
- Create: `packages/gateway/src/decisions/decision-types.ts`
- Create: `packages/gateway/src/decisions/decision-source-types.ts`
- Test: `packages/gateway/src/decisions/decision-source-types.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `type DecisionStatus = "pending" | "extracted" | "vetoed"`
  - `type CueTier = "heading" | "explicit" | "weak"`
  - `type EvidenceKind = "source" | "pr" | "commit" | "migration" | "iac" | "adr"`
  - `type ExtractionSource = "llm" | "snippet"`
  - `interface DecisionEvidence { kind; entityId; itemId; label; url; occurredAt }`
  - `interface DecisionRecord { id; sourceItemId; status; statement; rationale; alternatives; extractionSource; cueTier; cueText; priority; confidence; decidedAt; hasAdr; attempts; lastAttemptAt }`
  - `DECISION_SOURCE_TYPES: ReadonlySet<string>`
  - `decisionSourceFilter(): { sql: string; params: string[] }`

- [ ] **Step 1: Write the failing test**

Create `packages/gateway/src/decisions/decision-source-types.test.ts`:

```typescript
import { expect, test } from "bun:test";

import { DECISION_SOURCE_TYPES, decisionSourceFilter } from "./decision-source-types.ts";

test("admits the discussion and ticket sources the spec names", () => {
  for (const key of [
    "slack:message",
    "notion:page",
    "confluence:page",
    "linear:issue",
    "jira:issue",
  ]) {
    expect(DECISION_SOURCE_TYPES.has(key)).toBe(true);
  }
});

test("excludes email and calendar", () => {
  expect(DECISION_SOURCE_TYPES.has("gmail:email")).toBe(false);
  expect(DECISION_SOURCE_TYPES.has("google:calendar_event")).toBe(false);
});

test("the filter is service-qualified, so a same-named type from another service is excluded", () => {
  const { sql, params } = decisionSourceFilter();
  expect(sql).toContain("(i.service || ':' || i.type)");
  expect(params).toContain("jira:issue");
  expect(params).not.toContain("issue");
  expect(params).not.toContain("wiz:issue");
});

test("the filter emits one placeholder per key", () => {
  const { sql, params } = decisionSourceFilter();
  expect(sql.split("?").length - 1).toBe(params.length);
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
bun test packages/gateway/src/decisions/decision-source-types.test.ts
```

Expected: FAIL — module not found.

- [ ] **Step 3: Write `decision-types.ts`**

```typescript
export type DecisionStatus = "pending" | "extracted" | "vetoed";
export type CueTier = "heading" | "explicit" | "weak";
export type EvidenceKind = "source" | "pr" | "commit" | "migration" | "iac" | "adr";
export type ExtractionSource = "llm" | "snippet";

export interface DecisionEvidence {
  readonly kind: EvidenceKind;
  readonly entityId: string | null;
  readonly itemId: string | null;
  readonly label: string;
  readonly url: string | null;
  readonly occurredAt: number | null;
}

export interface DecisionRecord {
  readonly id: string;
  readonly sourceItemId: string;
  readonly status: DecisionStatus;
  readonly statement: string | null;
  readonly rationale: string | null;
  readonly alternatives: readonly string[];
  readonly extractionSource: ExtractionSource | null;
  readonly cueTier: CueTier;
  readonly cueText: string;
  readonly priority: number;
  readonly confidence: number;
  readonly decidedAt: number;
  readonly hasAdr: boolean;
  readonly attempts: number;
  readonly lastAttemptAt: number;
  readonly evidence: readonly DecisionEvidence[];
}
```

- [ ] **Step 4: Write `decision-source-types.ts`**

```typescript
/**
 * Which indexed item types feed decision mining.
 *
 * Email and calendar are deliberately absent, matching `glossary`: mining a
 * personal inbox into a TEAM artifact is not a posture to adopt silently.
 *
 * Keys are `service:type`. Filtering on the bare `type` half would silently
 * widen scope — `message`, `page` and `issue` are generic names shared across
 * services, so `type IN (...)` also admits `wiz:issue` (cloud-security posture
 * findings) today and any user-installed extension emitting `message`
 * tomorrow.
 */
export const DECISION_SOURCE_TYPES: ReadonlySet<string> = new Set([
  "slack:message",
  "discord:message",
  "teams:message",
  "notion:page",
  "confluence:page",
  "obsidian:obsidian_note",
  "linear:issue",
  "jira:issue",
  "github:issue",
  "gitlab:issue",
]);

/** The table MUST be aliased `i`. */
const DECISION_SOURCE_MATCH_SQL = "(i.service || ':' || i.type)";

export function decisionSourceFilter(): { sql: string; params: string[] } {
  const keys = [...DECISION_SOURCE_TYPES];
  const placeholders = keys.map(() => "?").join(", ");
  return { sql: `${DECISION_SOURCE_MATCH_SQL} IN (${placeholders})`, params: keys };
}
```

- [ ] **Step 5: Run the test to verify it passes**

```bash
bun test packages/gateway/src/decisions/decision-source-types.test.ts
```

Expected: PASS, 4 tests.

- [ ] **Step 6: Commit**

```bash
git add packages/gateway/src/decisions/
git commit -m "feat(decisions): add decision types and the service-qualified source allowlist"
```

---

## Task 3: Cue mining

This is where precision starts. The miner is high-recall by design; Task 7's LLM supplies precision.

**Files:**
- Create: `packages/gateway/src/decisions/cue-mining.ts`
- Test: `packages/gateway/src/decisions/cue-mining.test.ts`

**Interfaces:**
- Consumes: `CueTier` from `decision-types.ts`.
- Produces:
  - `normalizeSentence(raw: string): string`
  - `splitSentences(text: string): string[]`
  - `mineCues(text: string): CueHit[]` where `CueHit = { sentence: string; normalized: string; cueText: string; tier: CueTier }`
  - `decisionRowId(sourceItemId: string, normalizedSentence: string): string`

- [ ] **Step 1: Write the failing test**

Create `packages/gateway/src/decisions/cue-mining.test.ts`:

```typescript
import { expect, test } from "bun:test";

import { decisionRowId, mineCues, normalizeSentence, splitSentences } from "./cue-mining.ts";

test("normalizeSentence lowercases, collapses whitespace and strips trailing punctuation", () => {
  expect(normalizeSentence("  We   DECIDED to ship!!  ")).toBe("we decided to ship");
});

test("splitSentences splits on sentence terminators and newlines", () => {
  expect(splitSentences("One. Two! Three?\nFour")).toEqual(["One.", "Two!", "Three?", "Four"]);
});

test("tiers a heading cue above an explicit one", () => {
  const heading = mineCues("Decision: adopt Postgres");
  expect(heading).toHaveLength(1);
  expect(heading[0]?.tier).toBe("heading");

  const explicit = mineCues("So we decided to adopt Postgres");
  expect(explicit[0]?.tier).toBe("explicit");
});

test("tiers a bare preference cue as weak", () => {
  expect(mineCues("we'll use Postgres for this")[0]?.tier).toBe("weak");
});

// Negative cases. A cue miner tested only on positives proves nothing about
// precision, and these are the exact false positives the spec calls out.
test("still emits candidates for non-decisions — vetoing them is the LLM's job, not the miner's", () => {
  const hits = mineCues("we decided to grab lunch at noon");
  expect(hits).toHaveLength(1);
  expect(hits[0]?.tier).toBe("explicit");
});

test("emits nothing when no cue is present", () => {
  expect(mineCues("The deploy finished at 14:02 and the dashboard looks fine.")).toEqual([]);
});

test("emits one hit per sentence, not one per cue occurrence", () => {
  expect(mineCues("we decided we decided to move on")).toHaveLength(1);
});

test("row id is stable for the same normalized sentence and differs across items", () => {
  const a = decisionRowId("slack:1", normalizeSentence("We decided to ship."));
  const b = decisionRowId("slack:1", normalizeSentence("  we DECIDED to ship  "));
  const c = decisionRowId("slack:2", normalizeSentence("We decided to ship."));
  expect(a).toBe(b);
  expect(a).not.toBe(c);
});

test("row id ignores edits outside the cue sentence", () => {
  const first = mineCues("Intro text. We decided to ship.");
  const second = mineCues("Intro text, now with a typo fixed. We decided to ship.");
  expect(first[0]).toBeDefined();
  expect(second[0]).toBeDefined();
  expect(decisionRowId("i1", first[0]!.normalized)).toBe(
    decisionRowId("i1", second[0]!.normalized),
  );
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
bun test packages/gateway/src/decisions/cue-mining.test.ts
```

Expected: FAIL — module not found.

- [ ] **Step 3: Write the implementation**

Create `packages/gateway/src/decisions/cue-mining.ts`:

```typescript
import type { CueTier } from "./decision-types.ts";

export interface CueHit {
  readonly sentence: string;
  readonly normalized: string;
  readonly cueText: string;
  readonly tier: CueTier;
}

/**
 * Sentence-level normalisation, local to this module rather than borrowed from
 * `glossary`'s `normalizeTerm`. That helper normalises single TERMS and would
 * strip the internal structure a sentence needs; the two operations only look
 * alike. Keeping it local also avoids a glossary↔decisions import edge.
 */
export function normalizeSentence(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim()
    .replace(/[.!?,;:]+$/u, "")
    .trim();
}

export function splitSentences(text: string): string[] {
  return text
    .split(/(?<=[.!?])\s+|\n+/u)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/**
 * Ordered most-specific first. `mineCues` takes the FIRST match per sentence,
 * so a sentence carrying both a heading and a weak cue is tiered by the
 * stronger one.
 */
const CUES: ReadonlyArray<{ re: RegExp; tier: CueTier }> = [
  { re: /^\s*#{0,4}\s*(decision|outcome|resolution)\s*:/iu, tier: "heading" },
  { re: /\brfc\s+accepted\b/iu, tier: "heading" },
  { re: /\bwe\s+(?:have\s+)?decided\b/iu, tier: "explicit" },
  { re: /\bwe(?:'ve|\s+have)\s+agreed\b/iu, tier: "explicit" },
  { re: /\bwe\s+agreed\s+to\b/iu, tier: "explicit" },
  { re: /\bthe\s+decision\s+(?:was|is)\b/iu, tier: "explicit" },
  { re: /\bwe(?:'ve|\s+have)\s+settled\s+on\b/iu, tier: "explicit" },
  { re: /\bwe'll\s+use\b/iu, tier: "weak" },
  { re: /\bwe\s+will\s+use\b/iu, tier: "weak" },
  { re: /\bgoing\s+with\b/iu, tier: "weak" },
  { re: /\blet's\s+go\s+with\b/iu, tier: "weak" },
  { re: /\binstead\s+of\b/iu, tier: "weak" },
];

export function mineCues(text: string): CueHit[] {
  const hits: CueHit[] = [];
  for (const sentence of splitSentences(text)) {
    for (const { re, tier } of CUES) {
      const m = re.exec(sentence);
      if (m === null) continue;
      hits.push({
        sentence,
        normalized: normalizeSentence(sentence),
        cueText: m[0].trim(),
        tier,
      });
      break; // one hit per sentence — see the ordering note above
    }
  }
  return hits;
}

/**
 * Content-derived identity: hash(sourceItemId, normalized cue sentence).
 *
 * Deliberately NOT positional. Keying on the cue's character offset would mean
 * a typo fix earlier in a document re-hashes every later cue — re-queueing rows
 * already extracted and, worse, resurrecting `vetoed` rows under new ids so the
 * model is asked again about candidates it already rejected.
 */
export function decisionRowId(sourceItemId: string, normalizedSentence: string): string {
  const h = new Bun.CryptoHasher("blake3");
  h.update(sourceItemId);
  h.update(" ");
  h.update(normalizedSentence);
  return h.digest("hex").slice(0, 32);
}
```

- [ ] **Step 4: Run the test to verify it passes**

```bash
bun test packages/gateway/src/decisions/cue-mining.test.ts
```

Expected: PASS, 9 tests. If `splitSentences` fails the `"One. Two! Three?\nFour"` case, check the lookbehind — Bun supports it, but the `\n+` alternative must come second so a terminator followed by a newline splits once, not twice.

- [ ] **Step 5: Commit**

```bash
git add packages/gateway/src/decisions/cue-mining.ts packages/gateway/src/decisions/cue-mining.test.ts
git commit -m "feat(decisions): add cue mining with content-derived row identity"
```

---

## Task 4: Confidence and priority scoring

**Files:**
- Create: `packages/gateway/src/decisions/decision-confidence.ts`
- Test: `packages/gateway/src/decisions/decision-confidence.test.ts`

**Interfaces:**
- Consumes: `CueTier`, `EvidenceKind` from `decision-types.ts`.
- Produces:
  - `cueStrength(tier: CueTier): number`
  - `sourceAuthority(serviceType: string): number`
  - `computePriority(input: { tier: CueTier; serviceType: string }): number`
  - `computeConfidence(input: { tier; serviceType; evidenceKinds: readonly EvidenceKind[]; hasRationale: boolean; hasAlternatives: boolean }): number`
  - `explainConfidence(input): Array<{ term: string; value: number; detail: string }>`

- [ ] **Step 1: Write the failing test**

Create `packages/gateway/src/decisions/decision-confidence.test.ts`:

```typescript
import { expect, test } from "bun:test";

import { computeConfidence, computePriority, explainConfidence } from "./decision-confidence.ts";

test("a fully-evidenced heading decision on a page scores near 1", () => {
  const c = computeConfidence({
    tier: "heading",
    serviceType: "confluence:page",
    evidenceKinds: ["pr", "migration"],
    hasRationale: true,
    hasAlternatives: true,
  });
  expect(c).toBeCloseTo(1, 5);
});

test("a weak chat cue with no evidence and no rationale scores low", () => {
  const c = computeConfidence({
    tier: "weak",
    serviceType: "slack:message",
    evidenceKinds: [],
    hasRationale: false,
    hasAlternatives: false,
  });
  expect(c).toBeLessThan(0.2);
});

test("adding a migration to a PR raises corroboration", () => {
  const base = { tier: "explicit", serviceType: "jira:issue", hasRationale: true, hasAlternatives: false } as const;
  const pr = computeConfidence({ ...base, evidenceKinds: ["pr"] });
  const both = computeConfidence({ ...base, evidenceKinds: ["pr", "migration"] });
  expect(both).toBeGreaterThan(pr);
});

test("confidence never leaves 0..1", () => {
  const c = computeConfidence({
    tier: "heading",
    serviceType: "notion:page",
    evidenceKinds: ["pr", "commit", "migration", "iac", "adr"],
    hasRationale: true,
    hasAlternatives: true,
  });
  expect(c).toBeLessThanOrEqual(1);
  expect(c).toBeGreaterThanOrEqual(0);
});

// `source` is always present (the item the cue came from) and must not be
// mistaken for corroboration, or every decision would score as corroborated.
test("the 'source' evidence kind does not count as corroboration", () => {
  const base = { tier: "explicit", serviceType: "slack:message", hasRationale: false, hasAlternatives: false } as const;
  expect(computeConfidence({ ...base, evidenceKinds: ["source"] })).toBe(
    computeConfidence({ ...base, evidenceKinds: [] }),
  );
});

test("priority uses only the terms knowable before extraction", () => {
  const heading = computePriority({ tier: "heading", serviceType: "confluence:page" });
  const weak = computePriority({ tier: "weak", serviceType: "slack:message" });
  expect(heading).toBeGreaterThan(weak);
  // 0.25 * 1.0 + 0.20 * 1.0
  expect(heading).toBeCloseTo(0.45, 5);
});

test("explainConfidence returns one labelled row per term", () => {
  const rows = explainConfidence({
    tier: "heading",
    serviceType: "notion:page",
    evidenceKinds: ["pr"],
    hasRationale: true,
    hasAlternatives: false,
  });
  expect(rows.map((r) => r.term)).toEqual([
    "cue",
    "corroboration",
    "authority",
    "completeness",
  ]);
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
bun test packages/gateway/src/decisions/decision-confidence.test.ts
```

Expected: FAIL — module not found.

- [ ] **Step 3: Write the implementation**

Create `packages/gateway/src/decisions/decision-confidence.ts`:

```typescript
import type { CueTier, EvidenceKind } from "./decision-types.ts";

const W_CUE = 0.25;
const W_CORROBORATION = 0.35;
const W_AUTHORITY = 0.2;
const W_COMPLETENESS = 0.2;

export function cueStrength(tier: CueTier): number {
  if (tier === "heading") return 1;
  if (tier === "explicit") return 0.6;
  return 0.25;
}

/** Long-form docs outrank tickets, which outrank chat. */
export function sourceAuthority(serviceType: string): number {
  if (
    serviceType === "notion:page" ||
    serviceType === "confluence:page" ||
    serviceType === "obsidian:obsidian_note"
  ) {
    return 1;
  }
  if (serviceType.endsWith(":issue")) return 0.6;
  return 0.3;
}

/**
 * `source` is excluded deliberately: every decision has one by construction, so
 * counting it would corroborate everything and flatten the term to a constant.
 */
function corroboration(kinds: readonly EvidenceKind[]): number {
  const hasCode = kinds.includes("pr") || kinds.includes("commit");
  const hasArtifact = kinds.includes("migration") || kinds.includes("iac");
  if (hasCode && hasArtifact) return 1;
  if (hasCode) return 0.6;
  if (hasArtifact) return 0.6;
  return 0;
}

function completeness(hasRationale: boolean, hasAlternatives: boolean): number {
  return (hasRationale ? 0.5 : 0) + (hasAlternatives ? 0.5 : 0);
}

export interface PriorityInput {
  readonly tier: CueTier;
  readonly serviceType: string;
}

/**
 * Extraction-queue order. Uses ONLY the two terms knowable without a model,
 * because `confidence` is 0 for every pending row — ordering the queue by it
 * would be arbitrary and would let a burst of weak cues starve heading cues out
 * of the per-pass budget.
 */
export function computePriority(input: PriorityInput): number {
  return W_CUE * cueStrength(input.tier) + W_AUTHORITY * sourceAuthority(input.serviceType);
}

export interface ConfidenceInput extends PriorityInput {
  readonly evidenceKinds: readonly EvidenceKind[];
  readonly hasRationale: boolean;
  readonly hasAlternatives: boolean;
}

export function computeConfidence(input: ConfidenceInput): number {
  const raw =
    W_CUE * cueStrength(input.tier) +
    W_CORROBORATION * corroboration(input.evidenceKinds) +
    W_AUTHORITY * sourceAuthority(input.serviceType) +
    W_COMPLETENESS * completeness(input.hasRationale, input.hasAlternatives);
  return Math.min(1, Math.max(0, raw));
}

export function explainConfidence(
  input: ConfidenceInput,
): Array<{ term: string; value: number; detail: string }> {
  return [
    {
      term: "cue",
      value: W_CUE * cueStrength(input.tier),
      detail: `${input.tier} cue`,
    },
    {
      term: "corroboration",
      value: W_CORROBORATION * corroboration(input.evidenceKinds),
      detail:
        input.evidenceKinds.filter((k) => k !== "source").join(" + ") || "no downstream evidence",
    },
    {
      term: "authority",
      value: W_AUTHORITY * sourceAuthority(input.serviceType),
      detail: input.serviceType,
    },
    {
      term: "completeness",
      value: W_COMPLETENESS * completeness(input.hasRationale, input.hasAlternatives),
      detail: `rationale ${input.hasRationale ? "yes" : "no"}, alternatives ${
        input.hasAlternatives ? "yes" : "no"
      }`,
    },
  ];
}
```

- [ ] **Step 4: Run the test to verify it passes**

```bash
bun test packages/gateway/src/decisions/decision-confidence.test.ts
```

Expected: PASS, 7 tests.

- [ ] **Step 5: Commit**

```bash
git add packages/gateway/src/decisions/decision-confidence.ts \
        packages/gateway/src/decisions/decision-confidence.test.ts
git commit -m "feat(decisions): add the deterministic confidence and priority scorers"
```

---

## Task 5: The store

**Files:**
- Create: `packages/gateway/src/decisions/decision-store.ts`
- Test: `packages/gateway/src/decisions/decision-store.test.ts`

**Interfaces:**
- Consumes: `DecisionRecord`, `DecisionEvidence`, `DecisionStatus` (Task 2); `runMigrations` (Task 1).
- Produces:
  - `upsertCandidate(db, c: CandidateInsert): void` where `CandidateInsert = { id; sourceItemId; cueTier; cueText; priority; decidedAt; nowMs }`
  - `selectPendingByPriority(db, limit: number, cooldownBeforeMs: number): DecisionRecord[]`
  - `selectSnippetUpgrades(db, limit: number): DecisionRecord[]`
  - `markVetoed(db, id: string, nowMs: number): void`
  - `markExtracted(db, id, fields: { statement; rationale; alternatives; extractionSource }, nowMs): void`
  - `recordAttempt(db, id: string, nowMs: number): void`
  - `replaceEvidence(db, id: string, ev: readonly DecisionEvidence[]): void`
  - `setConfidence(db, id: string, confidence: number, hasAdr: boolean, nowMs: number): void`
  - `listDecisions(db, opts: { sinceMs; minConfidence; limit }): DecisionRecord[]`
  - `countByStatus(db): { total; pending; extracted; vetoed }`
  - `readPassState(db) / writePassState(db, s)`
  - `clearDecisions(db): void`

- [ ] **Step 1: Write the failing test**

Create `packages/gateway/src/decisions/decision-store.test.ts`:

```typescript
import { Database } from "bun:sqlite";
import { beforeEach, expect, test } from "bun:test";

import { runMigrations } from "../index/migrations/runner.ts";
import {
  countByStatus,
  listDecisions,
  markExtracted,
  markVetoed,
  readPassState,
  recordAttempt,
  replaceEvidence,
  selectPendingByPriority,
  selectSnippetUpgrades,
  setConfidence,
  upsertCandidate,
  writePassState,
} from "./decision-store.ts";

let db: Database;

beforeEach(() => {
  db = new Database(":memory:");
  runMigrations(db);
});

function candidate(id: string, priority: number, decidedAt = 1_000): void {
  upsertCandidate(db, {
    id,
    sourceItemId: `item-${id}`,
    cueTier: "explicit",
    cueText: "we decided",
    priority,
    decidedAt,
    nowMs: 5_000,
  });
}

test("upsertCandidate is idempotent on the same id", () => {
  candidate("a", 0.4);
  candidate("a", 0.4);
  expect(countByStatus(db).total).toBe(1);
});

test("selectPendingByPriority returns highest priority first", () => {
  candidate("low", 0.1);
  candidate("high", 0.9);
  expect(selectPendingByPriority(db, 10, 0).map((r) => r.id)).toEqual(["high", "low"]);
});

test("selectPendingByPriority breaks ties by decided_at DESC", () => {
  candidate("older", 0.5, 1_000);
  candidate("newer", 0.5, 9_000);
  expect(selectPendingByPriority(db, 10, 0).map((r) => r.id)).toEqual(["newer", "older"]);
});

test("a row attempted more recently than the cooldown is skipped", () => {
  candidate("a", 0.5);
  recordAttempt(db, "a", 10_000);
  expect(selectPendingByPriority(db, 10, 9_000)).toHaveLength(0);
  expect(selectPendingByPriority(db, 10, 11_000)).toHaveLength(1);
});

test("a vetoed row is never re-selected", () => {
  candidate("a", 0.5);
  markVetoed(db, "a", 6_000);
  expect(selectPendingByPriority(db, 10, 0)).toHaveLength(0);
  expect(countByStatus(db).vetoed).toBe(1);
});

test("markExtracted stores alternatives as a round-trippable array", () => {
  candidate("a", 0.5);
  markExtracted(
    db,
    "a",
    {
      statement: "Adopt Postgres",
      rationale: "pool exhaustion",
      alternatives: ["stay on MySQL", "shard"],
      extractionSource: "llm",
    },
    6_000,
  );
  const [row] = listDecisions(db, { sinceMs: 0, minConfidence: 0, limit: 10 });
  expect(row?.alternatives).toEqual(["stay on MySQL", "shard"]);
  expect(row?.statement).toBe("Adopt Postgres");
});

test("selectSnippetUpgrades returns only snippet-sourced extracted rows, oldest attempt first", () => {
  candidate("a", 0.5);
  candidate("b", 0.5);
  const fields = { statement: "s", rationale: null, alternatives: [], extractionSource: "snippet" } as const;
  markExtracted(db, "a", fields, 6_000);
  markExtracted(db, "b", { ...fields, extractionSource: "llm" }, 6_000);
  recordAttempt(db, "a", 1_000);
  expect(selectSnippetUpgrades(db, 10).map((r) => r.id)).toEqual(["a"]);
});

test("replaceEvidence is idempotent and readable back through listDecisions", () => {
  candidate("a", 0.5);
  markExtracted(db, "a", { statement: "s", rationale: null, alternatives: [], extractionSource: "llm" }, 6_000);
  const ev = [
    { kind: "pr", entityId: "e1", itemId: null, label: "#412", url: null, occurredAt: 7_000 },
  ] as const;
  replaceEvidence(db, "a", ev);
  replaceEvidence(db, "a", ev);
  const [row] = listDecisions(db, { sinceMs: 0, minConfidence: 0, limit: 10 });
  expect(row?.evidence).toHaveLength(1);
  expect(row?.evidence[0]?.label).toBe("#412");
});

test("listDecisions filters by since and min confidence, newest first", () => {
  candidate("old", 0.5, 1_000);
  candidate("new", 0.5, 9_000);
  const f = { statement: "s", rationale: null, alternatives: [], extractionSource: "llm" } as const;
  markExtracted(db, "old", f, 6_000);
  markExtracted(db, "new", f, 6_000);
  setConfidence(db, "old", 0.9, false, 6_000);
  setConfidence(db, "new", 0.1, false, 6_000);

  expect(listDecisions(db, { sinceMs: 5_000, minConfidence: 0, limit: 10 }).map((r) => r.id)).toEqual(["new"]);
  expect(listDecisions(db, { sinceMs: 0, minConfidence: 0.5, limit: 10 }).map((r) => r.id)).toEqual(["old"]);
});

test("listDecisions never returns pending or vetoed rows", () => {
  candidate("p", 0.5);
  candidate("v", 0.5);
  markVetoed(db, "v", 6_000);
  expect(listDecisions(db, { sinceMs: 0, minConfidence: 0, limit: 10 })).toHaveLength(0);
});

test("pass state round-trips", () => {
  writePassState(db, {
    watermarkMs: 42,
    watermarkId: "item-9",
    lastPassAt: 100,
    lastPassNew: 3,
    scannedItems: 7,
  });
  expect(readPassState(db)).toEqual({
    watermarkMs: 42,
    watermarkId: "item-9",
    lastPassAt: 100,
    lastPassNew: 3,
    scannedItems: 7,
  });
});

test("pass state defaults to a zero cursor before any pass", () => {
  expect(readPassState(db).watermarkMs).toBe(0);
  expect(readPassState(db).lastPassAt).toBeNull();
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
bun test packages/gateway/src/decisions/decision-store.test.ts
```

Expected: FAIL — module not found.

- [ ] **Step 3: Write the implementation**

Create `packages/gateway/src/decisions/decision-store.ts`. Every write uses `dbRun` (**I14**) with bound parameters (**I9**); reads use `db.query` (never `db.prepare`).

```typescript
import type { Database } from "bun:sqlite";

import { dbRun } from "../db/write.ts";
import type {
  CueTier,
  DecisionEvidence,
  DecisionRecord,
  EvidenceKind,
  ExtractionSource,
} from "./decision-types.ts";

export interface CandidateInsert {
  readonly id: string;
  readonly sourceItemId: string;
  readonly cueTier: CueTier;
  readonly cueText: string;
  readonly priority: number;
  readonly decidedAt: number;
  readonly nowMs: number;
}

export interface PassState {
  readonly watermarkMs: number;
  readonly watermarkId: string;
  readonly lastPassAt: number | null;
  readonly lastPassNew: number;
  readonly scannedItems: number;
}

type DecisionRow = {
  id: string;
  source_item_id: string;
  status: string;
  statement: string | null;
  rationale: string | null;
  alternatives: string;
  extraction_source: string | null;
  cue_tier: string;
  cue_text: string;
  priority: number;
  confidence: number;
  decided_at: number;
  has_adr: number;
  attempts: number;
  last_attempt_at: number;
};

type EvidenceRow = {
  decision_id: string;
  kind: string;
  entity_id: string | null;
  item_id: string | null;
  label: string;
  url: string | null;
  occurred_at: number | null;
};

function parseStringArray(raw: string): string[] {
  try {
    const v: unknown = JSON.parse(raw);
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}

function toRecord(r: DecisionRow, evidence: readonly DecisionEvidence[]): DecisionRecord {
  return {
    id: r.id,
    sourceItemId: r.source_item_id,
    status: r.status as DecisionRecord["status"],
    statement: r.statement,
    rationale: r.rationale,
    alternatives: parseStringArray(r.alternatives),
    extractionSource: r.extraction_source as ExtractionSource | null,
    cueTier: r.cue_tier as CueTier,
    cueText: r.cue_text,
    priority: r.priority,
    confidence: r.confidence,
    decidedAt: r.decided_at,
    hasAdr: r.has_adr === 1,
    attempts: r.attempts,
    lastAttemptAt: r.last_attempt_at,
    evidence,
  };
}

function evidenceFor(db: Database, ids: readonly string[]): Map<string, DecisionEvidence[]> {
  const out = new Map<string, DecisionEvidence[]>();
  if (ids.length === 0) return out;
  const ph = ids.map(() => "?").join(", ");
  const rows = db
    .query(`SELECT * FROM decision_evidence WHERE decision_id IN (${ph})`)
    .all(...ids) as EvidenceRow[];
  for (const r of rows) {
    const list = out.get(r.decision_id) ?? [];
    list.push({
      kind: r.kind as EvidenceKind,
      entityId: r.entity_id,
      itemId: r.item_id,
      label: r.label,
      url: r.url,
      occurredAt: r.occurred_at,
    });
    out.set(r.decision_id, list);
  }
  return out;
}

function hydrate(db: Database, rows: DecisionRow[]): DecisionRecord[] {
  const ev = evidenceFor(db, rows.map((r) => r.id));
  return rows.map((r) => toRecord(r, ev.get(r.id) ?? []));
}

/**
 * Upsert, not insert. Re-scanning an unchanged item re-derives the same
 * content-based id, and this must not resurrect a `vetoed` row or reset an
 * `extracted` one — so the conflict clause touches only the mined fields.
 */
export function upsertCandidate(db: Database, c: CandidateInsert): void {
  dbRun(
    db,
    `INSERT INTO decision_record
       (id, source_item_id, status, cue_tier, cue_text, priority, decided_at, updated_at)
     VALUES (?, ?, 'pending', ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       cue_tier   = excluded.cue_tier,
       cue_text   = excluded.cue_text,
       priority   = excluded.priority,
       decided_at = excluded.decided_at,
       updated_at = excluded.updated_at`,
    [c.id, c.sourceItemId, c.cueTier, c.cueText, c.priority, c.decidedAt, c.nowMs],
  );
}

export function selectPendingByPriority(
  db: Database,
  limit: number,
  cooldownBeforeMs: number,
): DecisionRecord[] {
  const rows = db
    .query(
      `SELECT * FROM decision_record
        WHERE status = 'pending' AND last_attempt_at <= ?
        ORDER BY priority DESC, decided_at DESC, id ASC
        LIMIT ?`,
    )
    .all(cooldownBeforeMs, limit) as DecisionRow[];
  return hydrate(db, rows);
}

export function selectSnippetUpgrades(db: Database, limit: number): DecisionRecord[] {
  const rows = db
    .query(
      `SELECT * FROM decision_record
        WHERE status = 'extracted' AND extraction_source = 'snippet'
        ORDER BY last_attempt_at ASC, id ASC
        LIMIT ?`,
    )
    .all(limit) as DecisionRow[];
  return hydrate(db, rows);
}

export function markVetoed(db: Database, id: string, nowMs: number): void {
  dbRun(
    db,
    `UPDATE decision_record
        SET status = 'vetoed', attempts = attempts + 1,
            last_attempt_at = ?, updated_at = ?
      WHERE id = ?`,
    [nowMs, nowMs, id],
  );
}

export function markExtracted(
  db: Database,
  id: string,
  fields: {
    statement: string;
    rationale: string | null;
    alternatives: readonly string[];
    extractionSource: ExtractionSource;
  },
  nowMs: number,
): void {
  dbRun(
    db,
    `UPDATE decision_record
        SET status = 'extracted', statement = ?, rationale = ?, alternatives = ?,
            extraction_source = ?, attempts = attempts + 1,
            last_attempt_at = ?, updated_at = ?
      WHERE id = ?`,
    [
      fields.statement,
      fields.rationale,
      JSON.stringify([...fields.alternatives]),
      fields.extractionSource,
      nowMs,
      nowMs,
      id,
    ],
  );
}

/** Records a failed attempt without changing status — the backoff input. */
export function recordAttempt(db: Database, id: string, nowMs: number): void {
  dbRun(
    db,
    `UPDATE decision_record
        SET attempts = attempts + 1, last_attempt_at = ?, updated_at = ?
      WHERE id = ?`,
    [nowMs, nowMs, id],
  );
}

export function replaceEvidence(
  db: Database,
  id: string,
  ev: readonly DecisionEvidence[],
): void {
  db.transaction(() => {
    dbRun(db, "DELETE FROM decision_evidence WHERE decision_id = ?", [id]);
    for (const e of ev) {
      dbRun(
        db,
        `INSERT OR REPLACE INTO decision_evidence
           (decision_id, kind, entity_id, item_id, label, url, occurred_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [id, e.kind, e.entityId, e.itemId, e.label, e.url, e.occurredAt],
      );
    }
  })();
}

export function setConfidence(
  db: Database,
  id: string,
  confidence: number,
  hasAdr: boolean,
  nowMs: number,
): void {
  dbRun(
    db,
    `UPDATE decision_record
        SET confidence = ?, has_adr = ?, stats_verified_at = ?, updated_at = ?
      WHERE id = ?`,
    [confidence, hasAdr ? 1 : 0, nowMs, nowMs, id],
  );
}

export function listDecisions(
  db: Database,
  opts: { sinceMs: number; minConfidence: number; limit: number },
): DecisionRecord[] {
  const rows = db
    .query(
      `SELECT * FROM decision_record
        WHERE status = 'extracted' AND decided_at >= ? AND confidence >= ?
        ORDER BY decided_at DESC, id ASC
        LIMIT ?`,
    )
    .all(opts.sinceMs, opts.minConfidence, opts.limit) as DecisionRow[];
  return hydrate(db, rows);
}

export function countByStatus(db: Database): {
  total: number;
  pending: number;
  extracted: number;
  vetoed: number;
} {
  const rows = db
    .query("SELECT status, COUNT(*) AS n FROM decision_record GROUP BY status")
    .all() as Array<{ status: string; n: number }>;
  const get = (s: string): number => rows.find((r) => r.status === s)?.n ?? 0;
  const pending = get("pending");
  const extracted = get("extracted");
  const vetoed = get("vetoed");
  return { total: pending + extracted + vetoed, pending, extracted, vetoed };
}

export function readPassState(db: Database): PassState {
  const r = db.query("SELECT * FROM decision_pass_state WHERE id = 1").get() as {
    watermark_ms: number;
    watermark_id: string;
    last_pass_at: number | null;
    last_pass_new: number;
    scanned_items: number;
  } | null;
  if (r === null) {
    return {
      watermarkMs: 0,
      watermarkId: "",
      lastPassAt: null,
      lastPassNew: 0,
      scannedItems: 0,
    };
  }
  return {
    watermarkMs: r.watermark_ms,
    watermarkId: r.watermark_id,
    lastPassAt: r.last_pass_at,
    lastPassNew: r.last_pass_new,
    scannedItems: r.scanned_items,
  };
}

export function writePassState(db: Database, s: PassState): void {
  dbRun(
    db,
    `INSERT INTO decision_pass_state
       (id, watermark_ms, watermark_id, last_pass_at, last_pass_new, scanned_items)
     VALUES (1, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       watermark_ms  = excluded.watermark_ms,
       watermark_id  = excluded.watermark_id,
       last_pass_at  = excluded.last_pass_at,
       last_pass_new = excluded.last_pass_new,
       scanned_items = excluded.scanned_items`,
    [s.watermarkMs, s.watermarkId, s.lastPassAt, s.lastPassNew, s.scannedItems],
  );
}

/** Used only by `--rebuild`. Clears vetoes too — that is the point of a rebuild. */
export function clearDecisions(db: Database): void {
  db.transaction(() => {
    dbRun(db, "DELETE FROM decision_evidence", []);
    dbRun(db, "DELETE FROM decision_record", []);
    dbRun(db, "DELETE FROM decision_pass_state", []);
  })();
}
```

- [ ] **Step 4: Run the test to verify it passes**

```bash
bun test packages/gateway/src/decisions/decision-store.test.ts
```

Expected: PASS, 12 tests.

- [ ] **Step 5: Verify the I14 static audit still passes**

```bash
bun run audit:invariants
```

Expected: PASS. A failure naming `decision-store.ts` means a raw `db.run` slipped in — every write must go through `dbRun`. If the script name differs, read `scripts/lib/preflight-gates.ts` and use the gate name listed there rather than guessing.

- [ ] **Step 6: Commit**

```bash
git add packages/gateway/src/decisions/decision-store.ts \
        packages/gateway/src/decisions/decision-store.test.ts
git commit -m "feat(decisions): add the decision store over the V47 tables"
```

---

## Task 6: Corroboration

**Files:**
- Create: `packages/gateway/src/decisions/decision-corroborate.ts`
- Test: `packages/gateway/src/decisions/decision-corroborate.test.ts`

**Interfaces:**
- Consumes: `DecisionEvidence`, `EvidenceKind` (Task 2).
- Produces:
  - `CORROBORATION_BACKWARD_MS`, `CORROBORATION_FORWARD_MS` constants
  - `corroborate(db, input: { decisionId; sourceItemId; decidedAt; statement }): DecisionEvidence[]`
  - `hasAdrEvidence(ev: readonly DecisionEvidence[]): boolean`

- [ ] **Step 1: Write the failing test**

Create `packages/gateway/src/decisions/decision-corroborate.test.ts`. Seed the graph directly — this mirrors how `why.ts`'s tests seed `graph_entity` / `graph_relation`; open `packages/gateway/src/agents/why.test.ts` first and copy its seeding helper shape so the two suites stay consistent.

```typescript
import { Database } from "bun:sqlite";
import { beforeEach, expect, test } from "bun:test";

import { runMigrations } from "../index/migrations/runner.ts";
import {
  CORROBORATION_BACKWARD_MS,
  CORROBORATION_FORWARD_MS,
  corroborate,
  hasAdrEvidence,
} from "./decision-corroborate.ts";

let db: Database;
const DECIDED_AT = 1_000_000_000;

beforeEach(() => {
  db = new Database(":memory:");
  runMigrations(db);
});

function seedItem(id: string, service: string, type: string, title: string, modifiedAt: number): void {
  db.run(
    `INSERT INTO item (id, service, type, external_id, title, modified_at, synced_at, pinned)
     VALUES (?, ?, ?, ?, ?, ?, ?, 0)`,
    [id, service, type, id, title, modifiedAt, modifiedAt],
  );
}

function seedPrMentionedBy(sourceItemId: string, prItemId: string, occurredAt: number): void {
  seedItem(prItemId, "github", "pr", "Move billing to Postgres", occurredAt);
  db.run(
    `INSERT INTO graph_entity (id, type, external_id, label) VALUES (?, 'pr', ?, ?)`,
    [`e-${prItemId}`, prItemId, "#412"],
  );
  db.run(
    `INSERT INTO graph_entity (id, type, external_id, label) VALUES (?, 'message', ?, ?)`,
    [`e-${sourceItemId}`, sourceItemId, "thread"],
  );
  db.run(
    `INSERT INTO graph_relation (from_id, to_id, type) VALUES (?, ?, 'mentions')`,
    [`e-${sourceItemId}`, `e-${prItemId}`],
  );
}

test("corroborates a PR mentioned by the source thread inside the forward window", () => {
  seedItem("src", "slack", "message", "thread", DECIDED_AT);
  seedPrMentionedBy("src", "pr1", DECIDED_AT + 3 * 24 * 3600 * 1000);
  const ev = corroborate(db, {
    decisionId: "d1",
    sourceItemId: "src",
    decidedAt: DECIDED_AT,
    statement: "Move billing to Postgres",
  });
  expect(ev.some((e) => e.kind === "pr")).toBe(true);
});

// The review's point 2: ship-then-write-it-up is the common case, not an edge.
test("corroborates a PR that PREDATES the decision inside the backward window", () => {
  seedItem("src", "slack", "message", "thread", DECIDED_AT);
  seedPrMentionedBy("src", "pr1", DECIDED_AT - 7 * 24 * 3600 * 1000);
  const ev = corroborate(db, {
    decisionId: "d1",
    sourceItemId: "src",
    decidedAt: DECIDED_AT,
    statement: "Move billing to Postgres",
  });
  expect(ev.some((e) => e.kind === "pr")).toBe(true);
});

test("does not corroborate a PR older than the backward window", () => {
  seedItem("src", "slack", "message", "thread", DECIDED_AT);
  seedPrMentionedBy("src", "pr1", DECIDED_AT - CORROBORATION_BACKWARD_MS - 1);
  const ev = corroborate(db, {
    decisionId: "d1",
    sourceItemId: "src",
    decidedAt: DECIDED_AT,
    statement: "Move billing to Postgres",
  });
  expect(ev.some((e) => e.kind === "pr")).toBe(false);
});

test("does not corroborate a PR beyond the forward window", () => {
  seedItem("src", "slack", "message", "thread", DECIDED_AT);
  seedPrMentionedBy("src", "pr1", DECIDED_AT + CORROBORATION_FORWARD_MS + 1);
  const ev = corroborate(db, {
    decisionId: "d1",
    sourceItemId: "src",
    decidedAt: DECIDED_AT,
    statement: "Move billing to Postgres",
  });
  expect(ev.some((e) => e.kind === "pr")).toBe(false);
});

test("always emits a 'source' evidence row for the originating item", () => {
  seedItem("src", "slack", "message", "thread", DECIDED_AT);
  const ev = corroborate(db, {
    decisionId: "d1",
    sourceItemId: "src",
    decidedAt: DECIDED_AT,
    statement: "anything",
  });
  expect(ev.filter((e) => e.kind === "source")).toHaveLength(1);
});

test("detects an ADR page sharing most of its tokens with the statement", () => {
  seedItem("src", "slack", "message", "thread", DECIDED_AT);
  seedItem("adr1", "notion", "page", "ADR: move billing to Postgres", DECIDED_AT);
  const ev = corroborate(db, {
    decisionId: "d1",
    sourceItemId: "src",
    decidedAt: DECIDED_AT,
    statement: "move billing to Postgres",
  });
  expect(hasAdrEvidence(ev)).toBe(true);
});

test("ADR candidate selection is deterministic under the cap", () => {
  seedItem("src", "slack", "message", "thread", DECIDED_AT);
  for (let i = 0; i < 5; i++) {
    seedItem(`adr${i}`, "notion", "page", `ADR: move billing to Postgres v${i}`, DECIDED_AT + i);
  }
  const first = corroborate(db, {
    decisionId: "d1",
    sourceItemId: "src",
    decidedAt: DECIDED_AT,
    statement: "move billing to Postgres",
  });
  const second = corroborate(db, {
    decisionId: "d1",
    sourceItemId: "src",
    decidedAt: DECIDED_AT,
    statement: "move billing to Postgres",
  });
  expect(first.filter((e) => e.kind === "adr").map((e) => e.label)).toEqual(
    second.filter((e) => e.kind === "adr").map((e) => e.label),
  );
});

test("a page whose title carries no ADR shape is never considered", () => {
  seedItem("src", "slack", "message", "thread", DECIDED_AT);
  seedItem("p1", "notion", "page", "move billing to Postgres", DECIDED_AT);
  const ev = corroborate(db, {
    decisionId: "d1",
    sourceItemId: "src",
    decidedAt: DECIDED_AT,
    statement: "move billing to Postgres",
  });
  expect(hasAdrEvidence(ev)).toBe(false);
});

test("an unrelated ADR page is not matched", () => {
  seedItem("src", "slack", "message", "thread", DECIDED_AT);
  seedItem("adr1", "notion", "page", "ADR: retire the legacy cron runner", DECIDED_AT);
  const ev = corroborate(db, {
    decisionId: "d1",
    sourceItemId: "src",
    decidedAt: DECIDED_AT,
    statement: "move billing to Postgres",
  });
  expect(hasAdrEvidence(ev)).toBe(false);
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
bun test packages/gateway/src/decisions/decision-corroborate.test.ts
```

Expected: FAIL — module not found.

- [ ] **Step 3: Write the implementation**

Create `packages/gateway/src/decisions/decision-corroborate.ts`:

```typescript
import type { Database } from "bun:sqlite";

import type { DecisionEvidence } from "./decision-types.ts";

/**
 * Asymmetric on purpose. Teams routinely ship first and formalise after — a
 * retro, a post-mortem, a wiki page updated the week following the merge. A
 * forward-only window would treat every one of those as uncorroborated and dock
 * it 0.35 confidence, which is exactly backwards.
 *
 * The cost is bounded: a thread referencing a recent PR as contrast can gain
 * confidence it has not earned, but only within 14 days AND only when a real
 * `mentions` / `merged_as` edge exists. Corroboration is never purely temporal.
 */
export const CORROBORATION_BACKWARD_MS = 14 * 24 * 60 * 60 * 1000;
export const CORROBORATION_FORWARD_MS = 90 * 24 * 60 * 60 * 1000;

const MIGRATION_RE = /(^|\/)migrations\//iu;
const MIGRATION_NAME_RE = /(^|\/)v\d+[-_]/iu;
const IAC_RE = /\.tfvars?$|\.tf$|(^|\/)pulumi\.ya?ml$|(^|\/)cloudformation\//iu;
const ADR_TITLE_RE = /\badr\b|^\d+[-.]|decision/iu;

const STOP = new Set(["the", "a", "an", "to", "of", "for", "and", "or", "on", "in", "we"]);

function tokens(s: string): string[] {
  return s
    .toLowerCase()
    .split(/[^a-z0-9]+/u)
    .filter((t) => t.length > 2 && !STOP.has(t));
}

/** At least half the statement's significant tokens must appear in the title. */
function tokenOverlap(statement: string, title: string): boolean {
  const want = tokens(statement);
  if (want.length === 0) return false;
  const have = new Set(tokens(title));
  const hits = want.filter((t) => have.has(t)).length;
  return hits * 2 >= want.length;
}

function classifyPaths(paths: readonly string[]): Array<"migration" | "iac"> {
  const kinds: Array<"migration" | "iac"> = [];
  if (paths.some((p) => MIGRATION_RE.test(p) || MIGRATION_NAME_RE.test(p))) kinds.push("migration");
  if (paths.some((p) => IAC_RE.test(p))) kinds.push("iac");
  return kinds;
}

export interface CorroborateInput {
  readonly decisionId: string;
  readonly sourceItemId: string;
  readonly decidedAt: number;
  readonly statement: string;
}

export function corroborate(db: Database, input: CorroborateInput): DecisionEvidence[] {
  const out: DecisionEvidence[] = [];

  const src = db
    .query("SELECT id, service, type, title, url, modified_at FROM item WHERE id = ?")
    .get(input.sourceItemId) as
    | { id: string; service: string; type: string; title: string; url: string | null; modified_at: number }
    | null;
  if (src !== null) {
    out.push({
      kind: "source",
      entityId: null,
      itemId: src.id,
      label: `${src.service}:${src.type} "${src.title}"`,
      url: src.url,
      occurredAt: src.modified_at,
    });
  }

  const lo = input.decidedAt - CORROBORATION_BACKWARD_MS;
  const hi = input.decidedAt + CORROBORATION_FORWARD_MS;

  // Code evidence: PRs and commits the source item references, via the graph
  // edges the populator already emits. Both endpoints are type-scoped because
  // `mentions` is polysemous.
  const code = db
    .query(
      `SELECT t.id AS entity_id, t.type AS entity_type, i.id AS item_id,
              i.title AS title, i.url AS url, i.modified_at AS modified_at,
              i.metadata AS metadata
         FROM graph_relation r
         JOIN graph_entity s ON s.id = r.from_id
         JOIN graph_entity t ON t.id = r.to_id AND t.type IN ('pr','commit')
         LEFT JOIN item i ON i.id = t.external_id
        WHERE s.external_id = ?
          AND r.type IN ('mentions','merged_as')
          AND i.modified_at BETWEEN ? AND ?
        ORDER BY i.modified_at ASC
        LIMIT 20`,
    )
    .all(input.sourceItemId, lo, hi) as Array<{
    entity_id: string;
    entity_type: string;
    item_id: string | null;
    title: string | null;
    url: string | null;
    modified_at: number | null;
    metadata: string | null;
  }>;

  for (const c of code) {
    out.push({
      kind: c.entity_type === "pr" ? "pr" : "commit",
      entityId: c.entity_id,
      itemId: c.item_id,
      label: c.title ?? c.entity_id,
      url: c.url,
      occurredAt: c.modified_at,
    });

    // Migration / IaC are properties OF a corroborating change, not separate
    // searches — a migration nobody linked to the decision proves nothing.
    let paths: string[] = [];
    if (c.metadata !== null) {
      try {
        const meta: unknown = JSON.parse(c.metadata);
        const f = (meta as { files?: unknown }).files;
        if (Array.isArray(f)) paths = f.filter((x): x is string => typeof x === "string");
      } catch {
        paths = [];
      }
    }
    for (const kind of classifyPaths(paths)) {
      out.push({
        kind,
        entityId: c.entity_id,
        itemId: c.item_id,
        label: `${kind} in ${c.title ?? c.entity_id}`,
        url: c.url,
        occurredAt: c.modified_at,
      });
    }
  }

  // ADR: a long-form doc whose title looks like an ADR and shares most of its
  // significant tokens with the statement.
  //
  // The title shape is filtered in SQL, not in JS. An earlier draft selected an
  // unordered `LIMIT 500` and filtered afterwards, which is a silent-truncation
  // bug rather than a slow one: with more long-form pages than the cap, SQLite
  // returns an ARBITRARY 500 and a real ADR simply never gets considered — with
  // no way for the caller to know. Pushing the shape test down means the cap is
  // reached only by pages that already look like ADRs, and `ORDER BY` makes
  // which ones deterministic.
  const adrs = db
    .query(
      `SELECT id, title, url, modified_at FROM item
        WHERE (service || ':' || type) IN ('notion:page','confluence:page','obsidian:obsidian_note')
          AND (LOWER(title) LIKE '%adr%'
            OR LOWER(title) LIKE '%decision%'
            OR title GLOB '[0-9]*')
        ORDER BY modified_at DESC, id ASC
        LIMIT 200`,
    )
    .all() as Array<{ id: string; title: string; url: string | null; modified_at: number }>;
  for (const a of adrs) {
    if (!ADR_TITLE_RE.test(a.title)) continue;
    if (!tokenOverlap(input.statement, a.title)) continue;
    out.push({
      kind: "adr",
      entityId: null,
      itemId: a.id,
      label: a.title,
      url: a.url,
      occurredAt: a.modified_at,
    });
    break;
  }

  return out;
}

export function hasAdrEvidence(ev: readonly DecisionEvidence[]): boolean {
  return ev.some((e) => e.kind === "adr");
}
```

- [ ] **Step 4: Run the test to verify it passes**

```bash
bun test packages/gateway/src/decisions/decision-corroborate.test.ts
```

Expected: PASS, 9 tests.

If the `graph_entity` / `graph_relation` column names in the seed helper do not match this repo's schema, read `packages/gateway/src/index/schema-sql.ts` for the real ones and fix **the test seed**, not the query — `why.ts` is the reference for what those tables actually look like.

- [ ] **Step 5: Commit**

```bash
git add packages/gateway/src/decisions/decision-corroborate.ts \
        packages/gateway/src/decisions/decision-corroborate.test.ts
git commit -m "feat(decisions): corroborate decisions against graph evidence in an asymmetric window"
```

---

## Task 7: The LLM adapter

**Files:**
- Create: `packages/gateway/src/decisions/decision-llm-adapter.ts`
- Test: `packages/gateway/src/decisions/decision-llm-adapter.test.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces:
  - `type DecisionLlm = { complete(prompt: string): Promise<string> }`
  - `buildExtractionPrompt(sentence: string, context: string): string`
  - `parseExtraction(raw: string): ExtractionOutcome` where `ExtractionOutcome = { kind: "veto" } | { kind: "decision"; statement: string; rationale: string | null; alternatives: string[] }`
  - `extractDecision(llm, sentence, context): Promise<ExtractionOutcome>`

- [ ] **Step 1: Write the failing test**

Create `packages/gateway/src/decisions/decision-llm-adapter.test.ts`:

```typescript
import { expect, test } from "bun:test";

import {
  buildExtractionPrompt,
  type DecisionLlm,
  extractDecision,
  parseExtraction,
} from "./decision-llm-adapter.ts";

function fakeLlm(reply: string): DecisionLlm {
  return { complete: async () => reply };
}

test("the prompt contains the sentence and demands strict JSON", () => {
  const p = buildExtractionPrompt("We decided to adopt Postgres.", "surrounding text");
  expect(p).toContain("We decided to adopt Postgres.");
  expect(p).toContain("JSON");
});

test("parses a decision with rationale and alternatives", () => {
  const out = parseExtraction(
    '{"is_decision":true,"statement":"Adopt Postgres","rationale":"pool exhaustion","alternatives":["MySQL","shard"]}',
  );
  expect(out).toEqual({
    kind: "decision",
    statement: "Adopt Postgres",
    rationale: "pool exhaustion",
    alternatives: ["MySQL", "shard"],
  });
});

test("parses a veto", () => {
  expect(parseExtraction('{"is_decision":false}')).toEqual({ kind: "veto" });
});

test("tolerates a model that wraps JSON in prose or a fenced block", () => {
  const out = parseExtraction(
    'Sure!\n```json\n{"is_decision":true,"statement":"Adopt Postgres"}\n```\nHope that helps.',
  );
  expect(out.kind).toBe("decision");
});

// A local model returning junk must be a VETO-free failure: the row stays
// pending and retries with backoff. Silently treating garbage as a veto would
// permanently discard a real decision.
test("throws on unparseable output rather than vetoing", () => {
  expect(() => parseExtraction("I could not determine that.")).toThrow();
});

test("throws when is_decision is true but no statement is given", () => {
  expect(() => parseExtraction('{"is_decision":true}')).toThrow();
});

test("a non-array alternatives field degrades to an empty list", () => {
  const out = parseExtraction('{"is_decision":true,"statement":"X","alternatives":"nope"}');
  expect(out).toEqual({ kind: "decision", statement: "X", rationale: null, alternatives: [] });
});

test("extractDecision round-trips through an injected llm", async () => {
  const out = await extractDecision(
    fakeLlm('{"is_decision":true,"statement":"Adopt Postgres"}'),
    "We decided to adopt Postgres.",
    "ctx",
  );
  expect(out.kind).toBe("decision");
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
bun test packages/gateway/src/decisions/decision-llm-adapter.test.ts
```

Expected: FAIL — module not found.

- [ ] **Step 3: Write the implementation**

Create `packages/gateway/src/decisions/decision-llm-adapter.ts`:

```typescript
export type DecisionLlm = {
  complete(prompt: string): Promise<string>;
};

export type ExtractionOutcome =
  | { readonly kind: "veto" }
  | {
      readonly kind: "decision";
      readonly statement: string;
      readonly rationale: string | null;
      readonly alternatives: readonly string[];
    };

export function buildExtractionPrompt(sentence: string, context: string): string {
  return [
    "You are analysing a message from an engineering team's私 internal discussion.",
    "Answer ONE question: is the sentence below recording a DECISION the team made?",
    "",
    "A decision commits the team to a course of action (technology, process, architecture).",
    "Casual plans about lunch, meetings or personal errands are NOT decisions.",
    "",
    `SENTENCE: ${sentence}`,
    `CONTEXT: ${context}`,
    "",
    "Reply with JSON only, no prose:",
    '{"is_decision": false}',
    "or",
    '{"is_decision": true, "statement": "<the decision, one line>",',
    ' "rationale": "<the because-clause, or null>",',
    ' "alternatives": ["<options considered and rejected>"]}',
  ].join("\n");
}

function extractJsonObject(raw: string): string {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/iu.exec(raw);
  const body = fenced?.[1] ?? raw;
  const start = body.indexOf("{");
  const end = body.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) {
    throw new Error("no JSON object in model output");
  }
  return body.slice(start, end + 1);
}

export function parseExtraction(raw: string): ExtractionOutcome {
  let parsed: unknown;
  try {
    parsed = JSON.parse(extractJsonObject(raw));
  } catch {
    throw new Error("model output was not parseable JSON");
  }
  if (parsed === null || typeof parsed !== "object") {
    throw new Error("model output was not a JSON object");
  }
  const o = parsed as {
    is_decision?: unknown;
    statement?: unknown;
    rationale?: unknown;
    alternatives?: unknown;
  };
  if (o.is_decision !== true) return { kind: "veto" };

  if (typeof o.statement !== "string" || o.statement.trim().length === 0) {
    throw new Error("model claimed a decision but gave no statement");
  }
  const alternatives = Array.isArray(o.alternatives)
    ? o.alternatives.filter((x): x is string => typeof x === "string")
    : [];
  return {
    kind: "decision",
    statement: o.statement.trim(),
    rationale: typeof o.rationale === "string" && o.rationale.trim().length > 0 ? o.rationale.trim() : null,
    alternatives,
  };
}

export async function extractDecision(
  llm: DecisionLlm,
  sentence: string,
  context: string,
): Promise<ExtractionOutcome> {
  return parseExtraction(await llm.complete(buildExtractionPrompt(sentence, context)));
}
```

- [ ] **Step 4: Run the test to verify it passes**

```bash
bun test packages/gateway/src/decisions/decision-llm-adapter.test.ts
```

Expected: PASS, 8 tests.

- [ ] **Step 5: Remove the stray non-ASCII character**

The prompt's first line above contains a stray CJK character (`私`) — an intentional plant to confirm you are reading the code you paste. Delete it so the line reads `"You are analysing a message from an engineering team's internal discussion.",` and re-run the test.

- [ ] **Step 6: Commit**

```bash
git add packages/gateway/src/decisions/decision-llm-adapter.ts \
        packages/gateway/src/decisions/decision-llm-adapter.test.ts
git commit -m "feat(decisions): add the veto-or-structure LLM adapter"
```

---

## Task 8: The extraction pass

**Files:**
- Create: `packages/gateway/src/decisions/decision-extract.ts`
- Test: `packages/gateway/src/decisions/decision-extract.test.ts`

**Interfaces:**
- Consumes: everything from Tasks 2–7.
- Produces:
  - `DecisionPassOptions = { nowMs; useLlm; maxLlmCalls; minConfidence; retryCooldownMs; llm?: DecisionLlm }`
  - `DecisionPassSummary = { scanned; discovered; extracted; vetoed; upgraded; failed }`
  - `runDecisionPass(db, opts): Promise<DecisionPassSummary>`
  - `rebuildDecisions(db, opts): Promise<DecisionPassSummary>`
  - `UPGRADE_RESERVE` constant

- [ ] **Step 1: Write the failing test**

Create `packages/gateway/src/decisions/decision-extract.test.ts`:

```typescript
import { Database } from "bun:sqlite";
import { beforeEach, expect, test } from "bun:test";

import { runMigrations } from "../index/migrations/runner.ts";
import { countByStatus, listDecisions, readPassState } from "./decision-store.ts";
import { rebuildDecisions, runDecisionPass } from "./decision-extract.ts";
import type { DecisionLlm } from "./decision-llm-adapter.ts";

let db: Database;

beforeEach(() => {
  db = new Database(":memory:");
  runMigrations(db);
});

function seed(id: string, service: string, type: string, title: string, body: string, at: number): void {
  db.run(
    `INSERT INTO item (id, service, type, external_id, title, body_preview, modified_at, synced_at, pinned)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0)`,
    [id, service, type, id, title, body, at, at],
  );
}

const OPTS = {
  nowMs: 10_000,
  useLlm: true,
  maxLlmCalls: 25,
  minConfidence: 0,
  retryCooldownMs: 1_000,
};

function scriptedLlm(replies: Record<string, string>, fallback: string): DecisionLlm {
  return {
    complete: async (prompt: string) => {
      for (const [needle, reply] of Object.entries(replies)) {
        if (prompt.includes(needle)) return reply;
      }
      return fallback;
    },
  };
}

test("discovers a cue, extracts it, and stores statement and rationale", async () => {
  seed("s1", "slack", "message", "thread", "We decided to move billing to Postgres.", 5_000);
  const llm = scriptedLlm(
    {
      billing:
        '{"is_decision":true,"statement":"Move billing to Postgres","rationale":"pool exhaustion","alternatives":["MySQL"]}',
    },
    '{"is_decision":false}',
  );
  const summary = await runDecisionPass(db, { ...OPTS, llm });
  expect(summary.discovered).toBe(1);
  expect(summary.extracted).toBe(1);
  const [row] = listDecisions(db, { sinceMs: 0, minConfidence: 0, limit: 10 });
  expect(row?.statement).toBe("Move billing to Postgres");
  expect(row?.rationale).toBe("pool exhaustion");
});

test("a vetoed candidate is not re-asked on a second pass", async () => {
  seed("s1", "slack", "message", "thread", "We decided to grab lunch at noon.", 5_000);
  let calls = 0;
  const llm: DecisionLlm = {
    complete: async () => {
      calls++;
      return '{"is_decision":false}';
    },
  };
  await runDecisionPass(db, { ...OPTS, llm });
  expect(calls).toBe(1);
  expect(countByStatus(db).vetoed).toBe(1);

  await runDecisionPass(db, { ...OPTS, nowMs: 20_000, llm });
  expect(calls).toBe(1);
});

test("the watermark advances even when extraction fails", async () => {
  seed("s1", "slack", "message", "thread", "We decided to ship it.", 5_000);
  const llm: DecisionLlm = { complete: async () => "unparseable" };
  await runDecisionPass(db, { ...OPTS, llm });
  expect(readPassState(db).watermarkMs).toBe(5_000);
  expect(countByStatus(db).pending).toBe(1); // stays pending, retries later
});

test("with no LLM the pass still produces snippet-sourced rows", async () => {
  seed("s1", "slack", "message", "thread", "We decided to move billing to Postgres.", 5_000);
  const summary = await runDecisionPass(db, { ...OPTS, useLlm: false });
  expect(summary.extracted).toBe(1);
  const [row] = listDecisions(db, { sinceMs: 0, minConfidence: 0, limit: 10 });
  expect(row?.extractionSource).toBe("snippet");
});

test("a later pass with an LLM upgrades a snippet row to llm-sourced", async () => {
  seed("s1", "slack", "message", "thread", "We decided to move billing to Postgres.", 5_000);
  await runDecisionPass(db, { ...OPTS, useLlm: false });

  const llm = scriptedLlm(
    { billing: '{"is_decision":true,"statement":"Move billing to Postgres","rationale":"pool"}' },
    '{"is_decision":false}',
  );
  const summary = await runDecisionPass(db, { ...OPTS, nowMs: 20_000, llm });
  expect(summary.upgraded).toBe(1);
  const [row] = listDecisions(db, { sinceMs: 0, minConfidence: 0, limit: 10 });
  expect(row?.extractionSource).toBe("llm");
});

// The review's point 3: weak cues must not consume the whole budget.
test("a heading candidate is extracted before a pool of weak ones", async () => {
  for (let i = 0; i < 5; i++) {
    seed(`w${i}`, "slack", "message", "t", `We'll use option ${i} for this.`, 1_000 + i);
  }
  seed("h1", "confluence", "page", "RFC", "Decision: adopt Postgres for billing.", 900);

  const seen: string[] = [];
  const llm: DecisionLlm = {
    complete: async (prompt: string) => {
      seen.push(prompt);
      return '{"is_decision":true,"statement":"x"}';
    },
  };
  await runDecisionPass(db, { ...OPTS, maxLlmCalls: 1, llm });
  expect(seen).toHaveLength(1);
  expect(seen[0]).toContain("adopt Postgres");
});

// The review's point 4.1: upgrades get a reserve, not leftovers.
test("a snippet upgrade still happens when new candidates would fill the budget", async () => {
  seed("s1", "slack", "message", "t", "We decided to move billing to Postgres.", 5_000);
  await runDecisionPass(db, { ...OPTS, useLlm: false });

  for (let i = 0; i < 20; i++) {
    seed(`n${i}`, "slack", "message", "t", `We decided on thing ${i}.`, 6_000 + i);
  }
  const llm: DecisionLlm = {
    complete: async () => '{"is_decision":true,"statement":"x"}',
  };
  const summary = await runDecisionPass(db, { ...OPTS, nowMs: 20_000, maxLlmCalls: 5, llm });
  expect(summary.upgraded).toBeGreaterThan(0);
});

test("rebuildDecisions clears vetoes so a candidate is re-evaluated", async () => {
  seed("s1", "slack", "message", "t", "We decided to grab lunch.", 5_000);
  await runDecisionPass(db, { ...OPTS, llm: scriptedLlm({}, '{"is_decision":false}') });
  expect(countByStatus(db).vetoed).toBe(1);

  const llm = scriptedLlm({}, '{"is_decision":true,"statement":"Lunch at noon"}');
  await rebuildDecisions(db, { ...OPTS, nowMs: 30_000, llm });
  expect(countByStatus(db).vetoed).toBe(0);
  expect(countByStatus(db).extracted).toBe(1);
});

test("items outside the source allowlist are never scanned", async () => {
  seed("w1", "wiz", "issue", "finding", "We decided to accept this risk.", 5_000);
  const summary = await runDecisionPass(db, { ...OPTS, useLlm: false });
  expect(summary.discovered).toBe(0);
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
bun test packages/gateway/src/decisions/decision-extract.test.ts
```

Expected: FAIL — module not found.

- [ ] **Step 3: Write the implementation**

Create `packages/gateway/src/decisions/decision-extract.ts`:

```typescript
import type { Database } from "bun:sqlite";

import { computeConfidence, computePriority } from "./decision-confidence.ts";
import { corroborate, hasAdrEvidence } from "./decision-corroborate.ts";
import { type DecisionLlm, extractDecision } from "./decision-llm-adapter.ts";
import { decisionSourceFilter } from "./decision-source-types.ts";
import {
  clearDecisions,
  countByStatus,
  markExtracted,
  markVetoed,
  readPassState,
  recordAttempt,
  replaceEvidence,
  selectPendingByPriority,
  selectSnippetUpgrades,
  setConfidence,
  upsertCandidate,
  writePassState,
} from "./decision-store.ts";
import type { DecisionRecord } from "./decision-types.ts";
import { decisionRowId, mineCues } from "./cue-mining.ts";

const SCAN_BATCH_LIMIT = 5000;

/**
 * Slots reserved for upgrading snippet rows, mirroring `glossary`'s
 * UPGRADE_RESERVE. A RESERVE, not leftover capacity: spending only what new
 * candidates leave behind means a busy index — exactly when the snippet backlog
 * grows — upgrades nothing, ever.
 */
export const UPGRADE_RESERVE = 5;

export interface DecisionPassOptions {
  readonly nowMs: number;
  readonly useLlm: boolean;
  readonly maxLlmCalls: number;
  readonly minConfidence: number;
  readonly retryCooldownMs: number;
  readonly llm?: DecisionLlm;
}

export interface DecisionPassSummary {
  readonly scanned: number;
  readonly discovered: number;
  readonly extracted: number;
  readonly vetoed: number;
  readonly upgraded: number;
  readonly failed: number;
}

type ScanRow = {
  id: string;
  service: string;
  type: string;
  title: string;
  body_preview: string | null;
  modified_at: number;
};

function scanDelta(db: Database, cursor: { watermarkMs: number; watermarkId: string }): ScanRow[] {
  const { sql, params } = decisionSourceFilter();
  return db
    .query(
      `SELECT i.id, i.service, i.type, i.title, i.body_preview, i.modified_at
         FROM item i
        WHERE ${sql}
          AND (i.modified_at > ? OR (i.modified_at = ? AND i.id > ?))
        ORDER BY i.modified_at ASC, i.id ASC
        LIMIT ?`,
    )
    .all(...params, cursor.watermarkMs, cursor.watermarkMs, cursor.watermarkId, SCAN_BATCH_LIMIT) as ScanRow[];
}

function scanText(r: ScanRow): string {
  return `${r.title}. ${r.body_preview ?? ""}`.trim();
}

/**
 * Phase A — discover. Pure SQL + regex, committed before any model call, and
 * the watermark advances HERE. Candidates are durable `pending` rows the moment
 * this returns, so an interrupted Phase B costs one in-flight call rather than
 * a full re-scan.
 */
function discoverPhase(db: Database, opts: DecisionPassOptions): { scanned: number; discovered: number } {
  const state = readPassState(db);
  const rows = scanDelta(db, state);
  if (rows.length === 0) return { scanned: 0, discovered: 0 };

  let discovered = 0;
  db.transaction(() => {
    for (const r of rows) {
      const serviceType = `${r.service}:${r.type}`;
      for (const hit of mineCues(scanText(r))) {
        upsertCandidate(db, {
          id: decisionRowId(r.id, hit.normalized),
          sourceItemId: r.id,
          cueTier: hit.tier,
          cueText: hit.cueText,
          priority: computePriority({ tier: hit.tier, serviceType }),
          decidedAt: r.modified_at,
          nowMs: opts.nowMs,
        });
        discovered++;
      }
    }
    const last = rows[rows.length - 1];
    if (last !== undefined) {
      writePassState(db, {
        watermarkMs: last.modified_at,
        watermarkId: last.id,
        lastPassAt: opts.nowMs,
        lastPassNew: discovered,
        scannedItems: state.scannedItems + rows.length,
      });
    }
  })();

  return { scanned: rows.length, discovered };
}

function serviceTypeOf(db: Database, itemId: string): string {
  const r = db.query("SELECT service, type FROM item WHERE id = ?").get(itemId) as
    | { service: string; type: string }
    | null;
  return r === null ? "unknown:unknown" : `${r.service}:${r.type}`;
}

function sentenceContext(db: Database, itemId: string): string {
  const r = db.query("SELECT title, body_preview FROM item WHERE id = ?").get(itemId) as
    | { title: string; body_preview: string | null }
    | null;
  return r === null ? "" : `${r.title}. ${r.body_preview ?? ""}`.trim();
}

/** Recompute evidence + confidence for one extracted row. */
function corroboratePhase(db: Database, id: string, statement: string, opts: DecisionPassOptions): void {
  const row = db
    .query("SELECT source_item_id, decided_at, cue_tier, rationale, alternatives FROM decision_record WHERE id = ?")
    .get(id) as
    | { source_item_id: string; decided_at: number; cue_tier: string; rationale: string | null; alternatives: string }
    | null;
  if (row === null) return;

  const evidence = corroborate(db, {
    decisionId: id,
    sourceItemId: row.source_item_id,
    decidedAt: row.decided_at,
    statement,
  });
  replaceEvidence(db, id, evidence);

  let alternativesCount = 0;
  try {
    const parsed: unknown = JSON.parse(row.alternatives);
    alternativesCount = Array.isArray(parsed) ? parsed.length : 0;
  } catch {
    alternativesCount = 0;
  }

  const confidence = computeConfidence({
    tier: row.cue_tier as "heading" | "explicit" | "weak",
    serviceType: serviceTypeOf(db, row.source_item_id),
    evidenceKinds: evidence.map((e) => e.kind),
    hasRationale: row.rationale !== null,
    hasAlternatives: alternativesCount > 0,
  });
  setConfidence(db, id, confidence, hasAdrEvidence(evidence), opts.nowMs);
}

/** Snippet mode: the mined sentence IS the statement. No model, no alternatives. */
function extractAsSnippet(db: Database, row: DecisionRecord, opts: DecisionPassOptions): void {
  const statement = row.cueText.length > 0 ? sentenceFor(db, row) : row.cueText;
  markExtracted(
    db,
    row.id,
    { statement, rationale: null, alternatives: [], extractionSource: "snippet" },
    opts.nowMs,
  );
  corroboratePhase(db, row.id, statement, opts);
}

/** Re-derives the mined sentence from the source item by matching the stored cue. */
function sentenceFor(db: Database, row: DecisionRecord): string {
  const text = sentenceContext(db, row.sourceItemId);
  for (const hit of mineCues(text)) {
    if (decisionRowId(row.sourceItemId, hit.normalized) === row.id) return hit.sentence;
  }
  return row.cueText;
}

async function extractOne(
  db: Database,
  row: DecisionRecord,
  llm: DecisionLlm,
  opts: DecisionPassOptions,
): Promise<"extracted" | "vetoed" | "failed"> {
  const sentence = sentenceFor(db, row);
  try {
    const outcome = await extractDecision(llm, sentence, sentenceContext(db, row.sourceItemId));
    if (outcome.kind === "veto") {
      markVetoed(db, row.id, opts.nowMs);
      return "vetoed";
    }
    markExtracted(
      db,
      row.id,
      {
        statement: outcome.statement,
        rationale: outcome.rationale,
        alternatives: outcome.alternatives,
        extractionSource: "llm",
      },
      opts.nowMs,
    );
    corroboratePhase(db, row.id, outcome.statement, opts);
    return "extracted";
  } catch {
    // Unparseable output is NOT a veto — the row stays pending and retries with
    // backoff. Treating garbage as rejection would silently discard real
    // decisions whenever a local model has a bad day.
    recordAttempt(db, row.id, opts.nowMs);
    return "failed";
  }
}

export async function runDecisionPass(
  db: Database,
  opts: DecisionPassOptions,
): Promise<DecisionPassSummary> {
  const { scanned, discovered } = discoverPhase(db, opts);

  let extracted = 0;
  let vetoed = 0;
  let upgraded = 0;
  let failed = 0;

  const cooldownBefore = opts.nowMs - opts.retryCooldownMs;

  if (opts.useLlm && opts.llm !== undefined) {
    const llm = opts.llm;
    const upgradeBudget = Math.min(UPGRADE_RESERVE, Math.max(0, opts.maxLlmCalls - 1));
    const pendingBudget = Math.max(0, opts.maxLlmCalls - upgradeBudget);

    for (const row of selectPendingByPriority(db, pendingBudget, cooldownBefore)) {
      const r = await extractOne(db, row, llm, opts);
      if (r === "extracted") extracted++;
      else if (r === "vetoed") vetoed++;
      else failed++;
    }
    for (const row of selectSnippetUpgrades(db, upgradeBudget)) {
      const r = await extractOne(db, row, llm, opts);
      if (r === "extracted") upgraded++;
      else if (r === "vetoed") vetoed++;
      else failed++;
    }
  } else {
    for (const row of selectPendingByPriority(db, opts.maxLlmCalls, cooldownBefore)) {
      extractAsSnippet(db, row, opts);
      extracted++;
    }
  }

  return { scanned, discovered, extracted, vetoed, upgraded, failed };
}

/**
 * Clears the store — vetoes included — and re-mines from scratch. The escape
 * hatch for the case veto durability otherwise creates: a veto is a judgement
 * by whatever local model was running, and without a reset an early or
 * misconfigured model would poison the store permanently.
 */
export async function rebuildDecisions(
  db: Database,
  opts: DecisionPassOptions,
): Promise<DecisionPassSummary> {
  clearDecisions(db);
  return await runDecisionPass(db, opts);
}

export { countByStatus };
```

- [ ] **Step 4: Run the test to verify it passes**

```bash
bun test packages/gateway/src/decisions/decision-extract.test.ts
```

Expected: PASS, 9 tests.

If the heading-priority test fails, check that `computePriority` is being stored on the row at discover time — the `ORDER BY priority DESC` is only meaningful if Phase A wrote it.

- [ ] **Step 5: Run the whole subsystem suite**

```bash
bun test packages/gateway/src/decisions/
```

Expected: PASS, all files.

- [ ] **Step 6: Commit**

```bash
git add packages/gateway/src/decisions/decision-extract.ts \
        packages/gateway/src/decisions/decision-extract.test.ts
git commit -m "feat(decisions): add the three-phase extraction pass with an upgrade reserve"
```

---

## Task 9: Config — `[decisions]`

**Files:**
- Create: `packages/gateway/src/config/nimbus-toml-decisions.ts`
- Modify: `packages/gateway/src/config/nimbus-toml.ts` (add the section dispatch beside the `[glossary]` one, ~line 1594)
- Test: `packages/gateway/src/config/nimbus-toml-decisions.test.ts`

**Interfaces:**
- Consumes: `forEachSectionEntry` and the section-parsing helpers already used by `[glossary]` in `nimbus-toml.ts`.
- Produces: `NimbusDecisionsToml = { enabled; useLlm; minConfidence; maxLlmCallsPerPass; debounceMs; retryCooldownMs }`, `DEFAULT_NIMBUS_DECISIONS_TOML`, `parseNimbusDecisionsToml(raw: string): NimbusDecisionsToml`.

- [ ] **Step 1: Read the glossary precedent**

Open `packages/gateway/src/config/nimbus-toml.ts` at the `[glossary]` block (search for `// [glossary] —`) and read through `applyNimbusGlossaryKey` and its `forEachSectionEntry` registration. Mirror that structure exactly — this task must not invent a second config-parsing idiom.

- [ ] **Step 2: Write the failing test**

Create `packages/gateway/src/config/nimbus-toml-decisions.test.ts`:

```typescript
import { expect, test } from "bun:test";

import { parseNimbusDecisionsToml } from "./nimbus-toml-decisions.ts";

test("defaults enabled and useLlm to true", () => {
  const cfg = parseNimbusDecisionsToml("");
  expect(cfg.enabled).toBe(true);
  expect(cfg.useLlm).toBe(true);
});

test("defaults match the spec", () => {
  const cfg = parseNimbusDecisionsToml("");
  expect(cfg.minConfidence).toBeCloseTo(0.3, 5);
  expect(cfg.maxLlmCallsPerPass).toBe(25);
});

test("parses use_llm as a bool, independently of enabled", () => {
  const cfg = parseNimbusDecisionsToml("[decisions]\nenabled = true\nuse_llm = false\n");
  expect(cfg.enabled).toBe(true);
  expect(cfg.useLlm).toBe(false);
});

test("parses min_confidence and max_llm_calls_per_pass", () => {
  const cfg = parseNimbusDecisionsToml("[decisions]\nmin_confidence = 0.7\nmax_llm_calls_per_pass = 4\n");
  expect(cfg.minConfidence).toBeCloseTo(0.7, 5);
  expect(cfg.maxLlmCallsPerPass).toBe(4);
});

test("clamps min_confidence into 0..1", () => {
  expect(parseNimbusDecisionsToml("[decisions]\nmin_confidence = 5\n").minConfidence).toBe(1);
  expect(parseNimbusDecisionsToml("[decisions]\nmin_confidence = -2\n").minConfidence).toBe(0);
});

test("ignores an unknown key rather than throwing", () => {
  expect(() => parseNimbusDecisionsToml("[decisions]\nnonsense = 1\n")).not.toThrow();
});
```

- [ ] **Step 3: Run the test to verify it fails**

```bash
bun test packages/gateway/src/config/nimbus-toml-decisions.test.ts
```

Expected: FAIL — module not found.

- [ ] **Step 4: Implement, following the glossary shape**

Create `nimbus-toml-decisions.ts` exporting the type, the `DEFAULT_NIMBUS_DECISIONS_TOML` literal, an `applyNimbusDecisionsKey(out, key, valRaw)` and `parseNimbusDecisionsToml`. Use the same value-coercion helpers `applyNimbusGlossaryKey` uses (bool before int — the glossary file carries a regression comment about `use_llm` being parsed as an int when the bool branch came second; do not reintroduce that bug).

Defaults: `enabled: true`, `useLlm: true`, `minConfidence: 0.3`, `maxLlmCallsPerPass: 25`, `debounceMs: 30_000`, `retryCooldownMs: 60_000`.

Then register the section in `nimbus-toml.ts` beside the glossary line:

```typescript
  forEachSectionEntry(raw, "[decisions]", (key, valRaw) => applyNimbusDecisionsKey(out, key, valRaw));
```

- [ ] **Step 5: Run the test to verify it passes**

```bash
bun test packages/gateway/src/config/nimbus-toml-decisions.test.ts
```

Expected: PASS, 6 tests.

- [ ] **Step 6: Commit**

```bash
git add packages/gateway/src/config/
git commit -m "feat(decisions): add the [decisions] nimbus.toml section"
```

---

## Task 10: The refresher and gateway wiring

**Files:**
- Create: `packages/gateway/src/decisions/decision-refresh.ts`
- Modify: `packages/gateway/src/platform/assemble.ts` (mirror `glossaryRefresher`: creation ~line 448, post-sync `trigger()` ~line 486, return ~line 529, `sidecarStops` ~line 1788, `ipcOpts` ~line 2103)
- Modify: `packages/gateway/src/ipc/server/options.ts` (add `decisionsRefresher?`)
- Test: `packages/gateway/src/decisions/decision-refresh.test.ts`

**Interfaces:**
- Consumes: `runDecisionPass`, `rebuildDecisions` (Task 8).
- Produces: `DecisionRefresher = { trigger(): void; run(opts?): Promise<DecisionPassSummary>; stop(): void }`, `createDecisionRefresher(deps): DecisionRefresher`.

- [ ] **Step 1: Read the glossary precedent**

Open `packages/gateway/src/glossary/glossary-refresh.ts` in full. It is ~150 lines and owns debounce, single-flight, abort-on-stop and error typing. Copy its structure; do not invent a different concurrency model.

- [ ] **Step 2: Write the failing test**

Create `packages/gateway/src/decisions/decision-refresh.test.ts`:

```typescript
import { expect, test } from "bun:test";

import { createDecisionRefresher } from "./decision-refresh.ts";

test("debounces bursts of triggers into a single run", async () => {
  let runs = 0;
  const r = createDecisionRefresher({
    debounceMs: 5,
    runPass: async () => {
      runs++;
      return { scanned: 0, discovered: 0, extracted: 0, vetoed: 0, upgraded: 0, failed: 0 };
    },
  });
  r.trigger();
  r.trigger();
  r.trigger();
  await new Promise((res) => setTimeout(res, 40));
  expect(runs).toBe(1);
  r.stop();
});

test("stop() prevents a pending debounced run", async () => {
  let runs = 0;
  const r = createDecisionRefresher({
    debounceMs: 20,
    runPass: async () => {
      runs++;
      return { scanned: 0, discovered: 0, extracted: 0, vetoed: 0, upgraded: 0, failed: 0 };
    },
  });
  r.trigger();
  r.stop();
  await new Promise((res) => setTimeout(res, 50));
  expect(runs).toBe(0);
});

test("run() surfaces the summary to the caller", async () => {
  const r = createDecisionRefresher({
    debounceMs: 5,
    runPass: async () => ({ scanned: 3, discovered: 2, extracted: 1, vetoed: 1, upgraded: 0, failed: 0 }),
  });
  expect((await r.run()).extracted).toBe(1);
  r.stop();
});

test("a failing pass does not wedge the refresher", async () => {
  let calls = 0;
  const r = createDecisionRefresher({
    debounceMs: 5,
    runPass: async () => {
      calls++;
      if (calls === 1) throw new Error("boom");
      return { scanned: 0, discovered: 0, extracted: 0, vetoed: 0, upgraded: 0, failed: 0 };
    },
  });
  await expect(r.run()).rejects.toThrow("boom");
  await expect(r.run()).resolves.toBeDefined();
  r.stop();
});
```

Note the injected `runPass` — no `mock.module`, per the global constraints.

- [ ] **Step 3: Run the test to verify it fails**

```bash
bun test packages/gateway/src/decisions/decision-refresh.test.ts
```

Expected: FAIL — module not found.

- [ ] **Step 4: Implement the refresher**

Write `decision-refresh.ts` with a `runPass` dependency injected (not imported directly) so the tests above work without module mocking. Timer handling: do **not** call `.unref()` on an awaited `setTimeout` — that spins 100% CPU on Windows in this repo's test runner.

- [ ] **Step 5: Wire it into `assemble.ts`**

Follow every `glossaryRefresher` site listed in the Files block: construct it with `runPass: () => runDecisionPass(db, optsFromConfig)`, call `decisionsRefresher.trigger()` in the same post-sync hook that triggers the glossary one, add it to the returned object, push its `stop()` onto `sidecarStops`, and assign it to `ipcOpts`. Gate construction on `config.decisions.enabled`.

- [ ] **Step 6: Run the tests**

```bash
bun test packages/gateway/src/decisions/decision-refresh.test.ts
bun run typecheck
```

Expected: PASS, then a clean typecheck. A typecheck failure in `assemble.ts` usually means the `options.ts` field was not added.

- [ ] **Step 7: Commit**

```bash
git add packages/gateway/src/decisions/decision-refresh.ts \
        packages/gateway/src/decisions/decision-refresh.test.ts \
        packages/gateway/src/platform/assemble.ts \
        packages/gateway/src/ipc/server/options.ts
git commit -m "feat(decisions): add the debounced post-sync refresher and wire it into assemble"
```

---

## Task 11: Brief types, rendering, synthesis

**Files:**
- Create: `packages/gateway/src/agents/_lib/decisions-types.ts`
- Modify: `packages/gateway/src/agents/_lib/emit-brief.ts` (`AnyBrief` union, ~line 15)
- Modify: `packages/gateway/src/agents/_lib/synthesize.ts` (two dispatch chains, ~lines 59-80)
- Modify: `packages/gateway/src/agents/_lib/render.ts` (add `renderDecisions`)
- Test: `packages/gateway/src/agents/_lib/render.decisions.test.ts`

**Interfaces:**
- Consumes: `DecisionRecord`, `DecisionEvidence` (Task 2); `GapNote` from `./findings.ts`.
- Produces:
  - `DecisionsInput = { sinceMs?: number; service?: string; minConfidence?: number; explain?: boolean; limit?: number }`
  - `DecisionsEntry` — the render-facing projection
  - `DecisionsBrief = { kind: "decisions"; agentVersion; generatedAt; latencyMs; gaps; query; entries; stats }`
  - `renderDecisions(brief: DecisionsBrief): string`

**Note:** `DecisionsBrief` stays **local**, exactly as `GlossaryBrief` did — it does **not** go into `@nimbus-dev/sdk`. `findings.ts` re-exports the SDK brief types, and adding a new one there would fan out into the satellite repos. Follow `agents/_lib/glossary-types.ts` as the precedent.

- [ ] **Step 1: Write the failing test**

Create `packages/gateway/src/agents/_lib/render.decisions.test.ts`:

```typescript
import { expect, test } from "bun:test";

import type { DecisionsBrief } from "./decisions-types.ts";
import { renderDecisions } from "./render.ts";

function brief(over: Partial<DecisionsBrief> = {}): DecisionsBrief {
  return {
    kind: "decisions",
    agentVersion: 1,
    generatedAt: 1_700_000_000_000,
    latencyMs: 12,
    gaps: [],
    query: { sinceMs: 0, service: null, minConfidence: 0, explain: false },
    entries: [
      {
        id: "d1",
        statement: "Move billing to Postgres",
        rationale: "connection-pool exhaustion",
        alternatives: ["stay on MySQL"],
        confidence: 0.78,
        decidedAt: 1_690_000_000_000,
        hasAdr: false,
        extractionSource: "llm",
        evidence: [
          { kind: "pr", entityId: null, itemId: null, label: "#412", url: null, occurredAt: null },
        ],
        explain: [],
        matchedVia: null,
      },
    ],
    stats: { total: 1, pending: 0, extracted: 1, vetoed: 0, lastPassAt: 1_699_000_000_000 },
    ...over,
  };
}

test("renders the statement, confidence and rationale", () => {
  const md = renderDecisions(brief());
  expect(md).toContain("Move billing to Postgres");
  expect(md).toContain("0.78");
  expect(md).toContain("connection-pool exhaustion");
});

test("flags a decision with no ADR", () => {
  expect(renderDecisions(brief())).toContain("no ADR found");
});

test("says so plainly when there are no decisions", () => {
  const md = renderDecisions(brief({ entries: [] }));
  expect(md).toContain("No decisions");
});

test("renders gap notes", () => {
  const md = renderDecisions(
    brief({ gaps: [{ category: "empty_index", detail: "The local index is empty." }] }),
  );
  expect(md).toContain("The local index is empty.");
});

test("renders the confidence breakdown only when explain is set", () => {
  const withExplain = brief();
  withExplain.query = { ...withExplain.query, explain: true };
  withExplain.entries[0]!.explain = [{ term: "cue", value: 0.25, detail: "heading cue" }];
  expect(renderDecisions(withExplain)).toContain("heading cue");
  expect(renderDecisions(brief())).not.toContain("heading cue");
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
bun test packages/gateway/src/agents/_lib/render.decisions.test.ts
```

Expected: FAIL — module not found.

- [ ] **Step 3: Write `decisions-types.ts`**

```typescript
import type { DecisionEvidence, ExtractionSource } from "../../decisions/decision-types.ts";
import type { ServiceMatchRoute } from "../../decisions/decision-service-scope.ts";
import type { GapNote } from "./findings.ts";

export interface DecisionsInput {
  readonly sinceMs?: number;
  readonly service?: string;
  readonly minConfidence?: number;
  readonly explain?: boolean;
  readonly limit?: number;
}

export interface DecisionsExplainTerm {
  readonly term: string;
  readonly value: number;
  readonly detail: string;
}

export interface DecisionsEntry {
  readonly id: string;
  readonly statement: string;
  readonly rationale: string | null;
  readonly alternatives: string[];
  readonly confidence: number;
  readonly decidedAt: number;
  readonly hasAdr: boolean;
  readonly extractionSource: ExtractionSource | null;
  readonly evidence: DecisionEvidence[];
  /** Populated only when `--explain` was requested; otherwise empty. */
  explain: DecisionsExplainTerm[];
  /** Which `--service` route matched, or null when no service filter applied. */
  readonly matchedVia: ServiceMatchRoute | null;
}

export interface DecisionsBrief {
  readonly kind: "decisions";
  readonly agentVersion: number;
  readonly generatedAt: number;
  readonly latencyMs: number;
  readonly gaps: GapNote[];
  query: {
    readonly sinceMs: number;
    readonly service: string | null;
    readonly minConfidence: number;
    readonly explain: boolean;
  };
  readonly entries: DecisionsEntry[];
  readonly stats: {
    readonly total: number;
    readonly pending: number;
    readonly extracted: number;
    readonly vetoed: number;
    readonly lastPassAt: number | null;
  };
}
```

`explain` and `query` are mutable so the Task 11 render test can rewrite them without fighting `readonly`; everything else is immutable.

- [ ] **Step 4: Add `renderDecisions` to `render.ts`**

Follow the existing `renderGlossary` in the same file for heading level, gap-note formatting and `NO_COLOR`-safe plain Markdown. Output shape per the spec:

```
## Decisions · 90d · 7 found

0.78  Move billing to Postgres                        2026-05-14
      ⚠ no ADR found
      rationale     connection-pool exhaustion under sustained load
      alternatives  stay on MySQL · shard by tenant
      evidence      notion:page "Billing RFC" · PR #412 · migration V12
```

- [ ] **Step 5: Wire the union and the two dispatch chains**

In `emit-brief.ts` add `| DecisionsBrief` to `AnyBrief` and import it. In `synthesize.ts` add both lines, beside the glossary ones:

```typescript
  if (brief.kind === "decisions") return renderDecisions(brief);
```
```typescript
  if (brief.kind === "decisions") return "agents.decisions";
```

- [ ] **Step 6: Run the tests**

```bash
bun test packages/gateway/src/agents/_lib/
bun run typecheck
```

Expected: PASS, 5 new tests, no regressions.

- [ ] **Step 7: Commit**

```bash
git add packages/gateway/src/agents/_lib/
git commit -m "feat(decisions): add the decisions brief type, renderer and synthesis dispatch"
```

---

## Task 12: Service scoping

Implements the `--service` flag's two resolution routes. The spec is explicit that route 1 alone silently drops process decisions — "Adopt trunk-based development" has no PR and never will — so both routes are required for the flag to mean what the spec says.

**Files:**
- Create: `packages/gateway/src/decisions/decision-service-scope.ts`
- Test: `packages/gateway/src/decisions/decision-service-scope.test.ts`

**Interfaces:**
- Consumes: `DecisionEvidence` (Task 2).
- Produces:
  - `type ServiceMatchRoute = "repo" | "ticket-key"`
  - `matchesService(db, input: { sourceItemId; evidence; service }): ServiceMatchRoute | null`

- [ ] **Step 1: Write the failing test**

Create `packages/gateway/src/decisions/decision-service-scope.test.ts`:

```typescript
import { Database } from "bun:sqlite";
import { beforeEach, expect, test } from "bun:test";

import { runMigrations } from "../index/migrations/runner.ts";
import { matchesService } from "./decision-service-scope.ts";
import type { DecisionEvidence } from "./decision-types.ts";

let db: Database;

beforeEach(() => {
  db = new Database(":memory:");
  runMigrations(db);
});

function prEvidence(itemId: string): DecisionEvidence[] {
  return [{ kind: "pr", entityId: null, itemId, label: "#412", url: null, occurredAt: null }];
}

/**
 * Seeds a PR the way `github-sync.ts:201` actually writes one: `external_id` is
 * `owner/repo#number`. Do NOT hand-build a `repository` graph entity here — no
 * populator emits one, so a test that seeds it would pass while production
 * matched nothing.
 */
function seedPrItem(itemId: string, externalId: string, metadata: string | null): void {
  db.run(
    `INSERT INTO item (id, service, type, external_id, title, metadata, modified_at, synced_at, pinned)
     VALUES (?, 'github', 'pr', ?, 'Move billing to Postgres', ?, 1, 1, 0)`,
    [itemId, externalId, metadata],
  );
}

function seedTicket(itemId: string, service: string, metadata: string): void {
  db.run(
    `INSERT INTO item (id, service, type, external_id, title, metadata, modified_at, synced_at, pinned)
     VALUES (?, ?, 'issue', ?, 't', ?, 1, 1, 0)`,
    [itemId, service, itemId, metadata],
  );
}

test("matches by repository via the PR item external_id", () => {
  seedPrItem("pr1", "acme/billing#412", null);
  expect(
    matchesService(db, { sourceItemId: "s1", evidence: prEvidence("pr1"), service: "billing" }),
  ).toBe("repo");
});

test("matches the full owner/repo form as well as the bare name", () => {
  seedPrItem("pr1", "acme/billing#412", null);
  expect(
    matchesService(db, { sourceItemId: "s1", evidence: prEvidence("pr1"), service: "acme/billing" }),
  ).toBe("repo");
});

test("prefers metadata.repo over the external_id prefix", () => {
  seedPrItem("pr1", "acme/wrong#412", JSON.stringify({ repo: "acme/billing" }));
  expect(
    matchesService(db, { sourceItemId: "s1", evidence: prEvidence("pr1"), service: "billing" }),
  ).toBe("repo");
});

test("does not match a different repository", () => {
  seedPrItem("pr1", "acme/payments#412", null);
  expect(
    matchesService(db, { sourceItemId: "s1", evidence: prEvidence("pr1"), service: "billing" }),
  ).toBeNull();
});

test("matches a Jira ticket by its project key", () => {
  seedTicket("j1", "jira", JSON.stringify({ key: "BILLING-123" }));
  expect(matchesService(db, { sourceItemId: "j1", evidence: [], service: "billing" })).toBe(
    "ticket-key",
  );
});

test("matches a Linear ticket by its identifier prefix", () => {
  seedTicket("l1", "linear", JSON.stringify({ identifier: "BILLING-7" }));
  expect(matchesService(db, { sourceItemId: "l1", evidence: [], service: "billing" })).toBe(
    "ticket-key",
  );
});

// The spec is explicit that matching is on normalized tokens, not substrings —
// this keeps the flag predictable rather than fuzzy.
test("does not substring-match a shorter query against a longer key", () => {
  seedTicket("j1", "jira", JSON.stringify({ key: "BILLING-123" }));
  expect(matchesService(db, { sourceItemId: "j1", evidence: [], service: "bill" })).toBeNull();
});

test("returns null for a decision with neither route", () => {
  seedTicket("s1", "slack", JSON.stringify({ channel: "C0123" }));
  expect(matchesService(db, { sourceItemId: "s1", evidence: [], service: "billing" })).toBeNull();
});

// A Slack channel ID is opaque — the connector never persists the NAME, which is
// why the spec defers channel matching to a connector-side slice.
test("never matches a Slack channel id", () => {
  seedTicket("s1", "slack", JSON.stringify({ channel: "billing" }));
  expect(matchesService(db, { sourceItemId: "s1", evidence: [], service: "billing" })).toBeNull();
});

test("matching is case-insensitive", () => {
  seedPrItem("pr1", "acme/Billing#412", null);
  expect(
    matchesService(db, { sourceItemId: "s1", evidence: prEvidence("pr1"), service: "BILLING" }),
  ).toBe("repo");
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
bun test packages/gateway/src/decisions/decision-service-scope.test.ts
```

Expected: FAIL — module not found.

- [ ] **Step 3: Write the implementation**

Create `packages/gateway/src/decisions/decision-service-scope.ts`:

```typescript
import type { Database } from "bun:sqlite";

import type { DecisionEvidence } from "./decision-types.ts";

export type ServiceMatchRoute = "repo" | "ticket-key";

/**
 * `--service` resolves through two routes, neither of which is `service → team`
 * ownership — that graph is a separate, unbuilt S1 item.
 *
 * Route 2 exists because route 1 alone silently drops PROCESS decisions.
 * "Adopt trunk-based development" has no PR and never will, and a repo-only
 * filter would exclude exactly the class of decision hardest to recover any
 * other way.
 *
 * A third route — matching a Slack channel or Notion database NAME — is not
 * buildable today and is deliberately absent: `slack-sync` persists
 * `metadata.channel` as the channel ID, and `notion-sync` / `confluence-sync`
 * persist only page IDs. Nothing human-readable exists in the index to match
 * against, so a decision living only in a chat channel is reachable by
 * `--since` but not by `--service`, and the brief says so.
 */
function normalize(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/gu, "");
}

/**
 * Resolves the repository of a corroborating PR/commit from the ITEM, not from
 * a graph edge.
 *
 * There is no `pr -> repository` edge to traverse. Verified in the tree:
 * `in_repo` is emitted only for `commit -> workspace` and `file -> workspace`
 * (`graph/graph-populator.ts:342,453`), the entity type is `repo` rather than
 * `repository`, and `agents/impact.ts` — the existing precedent — resolves
 * repos by LABEL lookup (`repoIdsForRepoLabel`, `type = 'repo'`), never by
 * walking an edge from a PR.
 *
 * So read what the connector actually wrote: `github-sync.ts:201` stores
 * `external_id` as `owner/repo#123`, and `graph-populator.ts:67` reads
 * `metadata.repo` / `metadata.project`. Prefer the metadata field, fall back to
 * the external-id prefix.
 */
function repoOfItem(db: Database, itemId: string): string | null {
  const row = db.query("SELECT external_id, metadata FROM item WHERE id = ?").get(itemId) as
    | { external_id: string; metadata: string | null }
    | null;
  if (row === null) return null;

  if (row.metadata !== null) {
    try {
      const m: unknown = JSON.parse(row.metadata);
      if (m !== null && typeof m === "object") {
        const rec = m as { repo?: unknown; project?: unknown };
        const v = typeof rec.repo === "string" ? rec.repo : rec.project;
        if (typeof v === "string" && v.length > 0) return v;
      }
    } catch {
      // fall through to the external-id form
    }
  }

  const hash = row.external_id.indexOf("#");
  return hash > 0 ? row.external_id.slice(0, hash) : null;
}

/** `--service billing` must match `acme/billing`, so compare the last segment too. */
function repoMatches(repoFull: string, service: string): boolean {
  const want = normalize(service);
  if (normalize(repoFull) === want) return true;
  const segment = repoFull.slice(repoFull.lastIndexOf("/") + 1);
  return normalize(segment) === want;
}

function matchesRepo(db: Database, evidence: readonly DecisionEvidence[], service: string): boolean {
  const itemIds = evidence
    .filter((e) => (e.kind === "pr" || e.kind === "commit") && e.itemId !== null)
    .map((e) => e.itemId as string);
  if (itemIds.length === 0) return false;

  for (const id of itemIds) {
    const repoFull = repoOfItem(db, id);
    if (repoFull !== null && repoMatches(repoFull, service)) return true;
  }
  return false;
}

/** Jira stores `metadata.key`, Linear `metadata.identifier`; both look like `BILLING-123`. */
function matchesTicketKey(db: Database, sourceItemId: string, service: string): boolean {
  const row = db.query("SELECT service, metadata FROM item WHERE id = ?").get(sourceItemId) as
    | { service: string; metadata: string | null }
    | null;
  if (row === null || row.metadata === null) return false;
  if (row.service !== "jira" && row.service !== "linear") return false;

  let raw: unknown;
  try {
    raw = JSON.parse(row.metadata);
  } catch {
    return false;
  }
  if (raw === null || typeof raw !== "object") return false;

  const m = raw as { key?: unknown; identifier?: unknown };
  const ident = typeof m.key === "string" ? m.key : typeof m.identifier === "string" ? m.identifier : null;
  if (ident === null) return false;

  const prefix = ident.split("-")[0] ?? "";
  return prefix.length > 0 && normalize(prefix) === normalize(service);
}

export function matchesService(
  db: Database,
  input: {
    readonly sourceItemId: string;
    readonly evidence: readonly DecisionEvidence[];
    readonly service: string;
  },
): ServiceMatchRoute | null {
  if (matchesRepo(db, input.evidence, input.service)) return "repo";
  if (matchesTicketKey(db, input.sourceItemId, input.service)) return "ticket-key";
  return null;
}
```

- [ ] **Step 4: Run the test to verify it passes**

```bash
bun test packages/gateway/src/decisions/decision-service-scope.test.ts
```

Expected: PASS, 10 tests.

Do **not** "fix" a failure here by seeding a `repository` graph entity and traversing an edge to it. That path does not exist: `in_repo` is emitted only for `commit -> workspace` and `file -> workspace` (`graph-populator.ts:342,453`), the repo entity type is `repo`, and no populator emits any `pr -> repo` edge at all. Route 1 resolves through the item, by design.

- [ ] **Step 5: Commit**

```bash
git add packages/gateway/src/decisions/decision-service-scope.ts \
        packages/gateway/src/decisions/decision-service-scope.test.ts
git commit -m "feat(decisions): resolve --service by repository and ticket project key"
```

---

## Task 13: The agent

**Files:**
- Create: `packages/gateway/src/agents/decisions.ts`
- Test: `packages/gateway/src/agents/decisions.test.ts`

**Interfaces:**
- Consumes: `listDecisions`, `countByStatus`, `readPassState` (Task 5); `explainConfidence` (Task 4); `matchesService` (Task 12); `DecisionsBrief` (Task 11); `AgentCoordinator` from `../engine/coordinator.ts`; `emitBriefWithSynthesis` from `./_lib/emit-brief.ts`.
- Produces: `DecisionsContext`, `runDecisions(input, ctx): Promise<DecisionsBrief>`, `emitDecisionsBrief(input, ctx): Promise<{ sessionId: string }>`.

**Read-only contract:** this file must not import `ToolExecutor` and must not reference `HITL_REQUIRED`. Task 16 asserts it structurally.

- [ ] **Step 1: Write the failing test**

Create `packages/gateway/src/agents/decisions.test.ts`:

```typescript
import { Database } from "bun:sqlite";
import { beforeEach, expect, test } from "bun:test";

import { runMigrations } from "../index/migrations/runner.ts";
import { markExtracted, setConfidence, upsertCandidate, writePassState } from "../decisions/decision-store.ts";
import { runDecisions } from "./decisions.ts";

let db: Database;

beforeEach(() => {
  db = new Database(":memory:");
  runMigrations(db);
});

function extracted(id: string, decidedAt: number, confidence: number): void {
  upsertCandidate(db, {
    id,
    sourceItemId: `item-${id}`,
    cueTier: "explicit",
    cueText: "we decided",
    priority: 0.5,
    decidedAt,
    nowMs: 1_000,
  });
  markExtracted(
    db,
    id,
    { statement: `Decision ${id}`, rationale: "because", alternatives: ["alt"], extractionSource: "llm" },
    1_000,
  );
  setConfidence(db, id, confidence, false, 1_000);
}

const ctx = () => ({ db, notify: () => {}, sessionId: "s1" });

// Note: every test passes an explicit `sinceMs: 0`. The agent defaults to a
// 90-day window, and these fixtures use small epoch timestamps (1970), so an
// omitted `sinceMs` filters every row out and the assertions fail confusingly.

test("returns extracted decisions newest first", async () => {
  extracted("a", 1_000, 0.9);
  extracted("b", 9_000, 0.9);
  writePassState(db, { watermarkMs: 9_000, watermarkId: "z", lastPassAt: 1_000, lastPassNew: 2, scannedItems: 2 });
  const brief = await runDecisions({ sinceMs: 0 }, ctx());
  expect(brief.entries.map((e) => e.id)).toEqual(["b", "a"]);
});

test("filters by minConfidence", async () => {
  extracted("low", 1_000, 0.1);
  extracted("high", 2_000, 0.9);
  writePassState(db, { watermarkMs: 2_000, watermarkId: "z", lastPassAt: 1_000, lastPassNew: 2, scannedItems: 2 });
  const brief = await runDecisions({ sinceMs: 0, minConfidence: 0.5 }, ctx());
  expect(brief.entries.map((e) => e.id)).toEqual(["high"]);
});

test("reports a gap when no pass has run", async () => {
  const brief = await runDecisions({}, ctx());
  expect(brief.gaps.some((g) => g.detail.includes("has not run"))).toBe(true);
});

test("reports the empty index only when also returning nothing", async () => {
  const brief = await runDecisions({}, ctx());
  expect(brief.gaps.some((g) => g.category === "empty_index")).toBe(true);
});

// The spec's standing honesty note.
test("always reports the 512-character body cap", async () => {
  extracted("a", 1_000, 0.9);
  writePassState(db, { watermarkMs: 1_000, watermarkId: "z", lastPassAt: 1_000, lastPassNew: 1, scannedItems: 1 });
  const brief = await runDecisions({ sinceMs: 0 }, ctx());
  expect(brief.gaps.some((g) => g.detail.includes("512"))).toBe(true);
});

test("includes the confidence breakdown only when explain is requested", async () => {
  extracted("a", 1_000, 0.9);
  writePassState(db, { watermarkMs: 1_000, watermarkId: "z", lastPassAt: 1_000, lastPassNew: 1, scannedItems: 1 });
  expect(
    (await runDecisions({ sinceMs: 0, explain: true }, ctx())).entries[0]?.explain.length,
  ).toBeGreaterThan(0);
  expect((await runDecisions({ sinceMs: 0 }, ctx())).entries[0]?.explain).toEqual([]);
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
bun test packages/gateway/src/agents/decisions.test.ts
```

Expected: FAIL — module not found.

- [ ] **Step 3: Write the agent**

Create `packages/gateway/src/agents/decisions.ts`:

```typescript
import type { Database } from "bun:sqlite";

import { explainConfidence } from "../decisions/decision-confidence.ts";
import { matchesService, type ServiceMatchRoute } from "../decisions/decision-service-scope.ts";
import { countByStatus, listDecisions, readPassState } from "../decisions/decision-store.ts";
import type { DecisionRecord } from "../decisions/decision-types.ts";
import { AgentCoordinator, type SubTask } from "../engine/coordinator.ts";
import type {
  DecisionsBrief,
  DecisionsEntry,
  DecisionsInput,
} from "./_lib/decisions-types.ts";
import { emitBriefWithSynthesis } from "./_lib/emit-brief.ts";
import type { GapNote } from "./_lib/findings.ts";
import type { SynthesizerLlm } from "./_lib/synthesize.ts";

export type DecisionsContext = {
  db: Database;
  notify: (method: string, params: unknown) => void;
  sessionId: string;
  llm?: SynthesizerLlm;
};

const DEFAULT_WINDOW_MS = 90 * 24 * 60 * 60 * 1000;
const DEFAULT_LIMIT = 50;

function subAgent(fn: () => unknown): SubTask {
  return {
    taskType: "agent_step",
    prompt: "",
    execute: async () => ({ text: JSON.stringify(fn()), tokensIn: 0, tokensOut: 0 }),
  };
}

function decode<T>(text: string | undefined, fallback: T): T {
  if (text === undefined) return fallback;
  try {
    return JSON.parse(text) as T;
  } catch {
    return fallback;
  }
}

function serviceTypeOf(db: Database, itemId: string): string {
  const r = db.query("SELECT service, type FROM item WHERE id = ?").get(itemId) as
    | { service: string; type: string }
    | null;
  return r === null ? "unknown:unknown" : `${r.service}:${r.type}`;
}

function toEntry(
  db: Database,
  r: DecisionRecord,
  explain: boolean,
  matchedVia: ServiceMatchRoute | null,
): DecisionsEntry {
  return {
    id: r.id,
    statement: r.statement ?? "",
    rationale: r.rationale,
    alternatives: [...r.alternatives],
    confidence: r.confidence,
    decidedAt: r.decidedAt,
    hasAdr: r.hasAdr,
    extractionSource: r.extractionSource,
    evidence: [...r.evidence],
    explain: explain
      ? explainConfidence({
          tier: r.cueTier,
          serviceType: serviceTypeOf(db, r.sourceItemId),
          evidenceKinds: r.evidence.map((e) => e.kind),
          hasRationale: r.rationale !== null,
          hasAlternatives: r.alternatives.length > 0,
        })
      : [],
    matchedVia,
  };
}

function buildGaps(
  db: Database,
  counts: { total: number; pending: number; extracted: number; vetoed: number },
  lastPassAt: number | null,
  entryCount: number,
  serviceUnmatched: number,
  snippetCount: number,
): GapNote[] {
  const gaps: GapNote[] = [];
  const anyItems = db.query("SELECT 1 FROM item LIMIT 1").get() !== null;

  // Claim an empty index ONLY when also returning nothing. Telling a user the
  // index is empty while showing them decisions is self-contradictory — the
  // same bug glossary already fixed.
  if (!anyItems && entryCount === 0) {
    gaps.push({
      category: "empty_index",
      detail: "The local index is empty, so no decisions could be extracted.",
      remediation: "Connect a source and run a sync, then try again.",
    });
  } else if (lastPassAt === null) {
    gaps.push({
      category: "missing_connector",
      detail: "The decision extraction pass has not run yet.",
      remediation: "Run `nimbus decisions --refresh`, or wait for the next connector sync.",
    });
  }

  if (counts.pending > 0) {
    gaps.push({
      category: "missing_connector",
      detail: `${String(counts.pending)} candidate(s) are still awaiting extraction.`,
      remediation: "The list fills in progressively — later passes will extract them.",
    });
  }

  if (snippetCount > 0) {
    gaps.push({
      category: "missing_connector",
      detail: `${String(snippetCount)} decision(s) are verbatim snippets rather than model-extracted.`,
      remediation:
        "Start a local model (Ollama or llama.cpp) and run `nimbus decisions --refresh`; " +
        "snippet rows are re-extracted automatically on later passes.",
    });
  }

  if (serviceUnmatched > 0) {
    gaps.push({
      category: "missing_relation_emit",
      detail:
        `${String(serviceUnmatched)} decision(s) match neither a repository nor a ticket project key.`,
      remediation:
        "Decisions recorded only in a chat channel or wiki page cannot be service-scoped " +
        "until those connectors index a human-readable channel/space name.",
    });
  }

  // Standing honesty note — permanent, not conditional. Recall is capped by
  // what the index actually holds, and a brief that omits this overstates it.
  gaps.push({
    category: "missing_relation_emit",
    detail:
      "Item bodies are indexed to 512 characters, so a decision stated later in a long " +
      "document or thread is not visible to this pass. Recall is capped, not complete.",
  });

  return gaps;
}

export async function runDecisions(
  input: DecisionsInput,
  ctx: DecisionsContext,
): Promise<DecisionsBrief> {
  const start = performance.now();
  const now = Date.now();
  const sinceMs = input.sinceMs ?? now - DEFAULT_WINDOW_MS;
  const minConfidence = input.minConfidence ?? 0;
  const limit = input.limit ?? DEFAULT_LIMIT;
  const explain = input.explain === true;
  const service = input.service ?? null;

  const coordinator = new AgentCoordinator({
    sessionId: ctx.sessionId,
    parentId: `decisions:${ctx.sessionId}`,
    depth: 1,
    toolCallCount: { value: 0 },
  });

  const tasks: SubTask[] = [
    subAgent(() => listDecisions(ctx.db, { sinceMs, minConfidence, limit })),
    subAgent(() => countByStatus(ctx.db)),
    subAgent(() => readPassState(ctx.db)),
  ];
  const results = await coordinator.run(tasks);

  const rows = decode<DecisionRecord[]>(results[0]?.text, []);
  const counts = decode(results[1]?.text, { total: 0, pending: 0, extracted: 0, vetoed: 0 });
  const passState = decode<{ lastPassAt: number | null }>(results[2]?.text, { lastPassAt: null });

  let serviceUnmatched = 0;
  const entries: DecisionsEntry[] = [];
  for (const r of rows) {
    if (service === null) {
      entries.push(toEntry(ctx.db, r, explain, null));
      continue;
    }
    const route = matchesService(ctx.db, {
      sourceItemId: r.sourceItemId,
      evidence: r.evidence,
      service,
    });
    if (route === null) {
      serviceUnmatched++;
      continue;
    }
    entries.push(toEntry(ctx.db, r, explain, route));
  }

  const snippetCount = rows.filter((r) => r.extractionSource === "snippet").length;

  return {
    kind: "decisions",
    agentVersion: 1,
    generatedAt: now,
    latencyMs: Math.round(performance.now() - start),
    gaps: buildGaps(
      ctx.db,
      counts,
      passState.lastPassAt,
      entries.length,
      serviceUnmatched,
      snippetCount,
    ),
    query: { sinceMs, service, minConfidence, explain },
    entries,
    stats: { ...counts, lastPassAt: passState.lastPassAt },
  };
}

export function emitDecisionsBrief(
  input: DecisionsInput,
  ctx: DecisionsContext,
): Promise<{ sessionId: string }> {
  return emitBriefWithSynthesis({
    sessionId: ctx.sessionId,
    briefReadyMethod: "decisions.briefReady",
    briefErrorMethod: "decisions.briefError",
    notify: ctx.notify,
    ...(ctx.llm === undefined ? {} : { llm: ctx.llm }),
    buildBrief: () => runDecisions(input, ctx),
  });
}
```

- [ ] **Step 4: Run the test to verify it passes**

```bash
bun test packages/gateway/src/agents/decisions.test.ts
```

Expected: PASS, 6 tests.

- [ ] **Step 5: Commit**

```bash
git add packages/gateway/src/agents/decisions.ts packages/gateway/src/agents/decisions.test.ts
git commit -m "feat(decisions): add the read-only decisions agent with three parallel lanes"
```

---

## Task 14: IPC and the Tauri allowlist

**Files:**
- Modify: `packages/gateway/src/ipc/agents-rpc.ts` (imports ~line 2/9; the `"glossary"` session-kind union ~line 187; handler beside `handleGlossary` ~line 453; dispatch map ~line 482)
- Modify: `packages/ui/src-tauri/src/gateway_bridge.rs` (`ALLOWED_METHODS` entry beside `"agents.glossary"` ~line 63; count assertion at line 519)
- Test: add to `packages/gateway/src/ipc/agents-rpc.test.ts`

**Interfaces:**
- Consumes: `emitDecisionsBrief`, `DecisionsInput` (Tasks 11–13).
- Produces: the `agents.decisions` JSON-RPC method.

- [ ] **Step 1: Write the failing test**

Add to `packages/gateway/src/ipc/agents-rpc.test.ts`, following the existing `agents.glossary` cases in that file:

```typescript
test("agents.decisions rejects a non-integer sinceMs", async () => {
  const res = await dispatchAgentsRpc("agents.decisions", { sinceMs: 1.5 }, testCtx());
  expect(res.hit).toBe(true);
  await expect(res.result).rejects.toThrow(/sinceMs/);
});

test("agents.decisions rejects minConfidence outside 0..1", async () => {
  const res = await dispatchAgentsRpc("agents.decisions", { minConfidence: 2 }, testCtx());
  await expect(res.result).rejects.toThrow(/minConfidence/);
});

test("agents.decisions returns a sessionId for valid params", async () => {
  const res = await dispatchAgentsRpc("agents.decisions", { sinceMs: 0 }, testCtx());
  expect((await res.result).sessionId).toMatch(/^decisions/);
});
```

Read the file's existing helpers first — `testCtx()` above stands for whatever context factory that suite already uses; use the real one rather than adding a second.

- [ ] **Step 2: Run the test to verify it fails**

```bash
bun test packages/gateway/src/ipc/agents-rpc.test.ts
```

Expected: FAIL — the method is not dispatched.

- [ ] **Step 3: Add the handler**

Mirror `handleGlossary` exactly:

```typescript
function requireDecisionsParams(params: unknown): DecisionsInput {
  if (params === null || params === undefined) return {};
  if (typeof params !== "object") {
    throw new AgentsRpcError(-32602, "params must be an object");
  }
  const p = params as Record<string, unknown>;
  if (p.sinceMs !== undefined && (typeof p.sinceMs !== "number" || !Number.isInteger(p.sinceMs) || p.sinceMs < 0)) {
    throw new AgentsRpcError(-32602, "sinceMs must be a non-negative integer");
  }
  if (p.minConfidence !== undefined && (typeof p.minConfidence !== "number" || p.minConfidence < 0 || p.minConfidence > 1)) {
    throw new AgentsRpcError(-32602, "minConfidence must be between 0 and 1");
  }
  if (p.service !== undefined && typeof p.service !== "string") {
    throw new AgentsRpcError(-32602, "service must be a string");
  }
  return {
    ...(p.sinceMs === undefined ? {} : { sinceMs: p.sinceMs as number }),
    ...(p.minConfidence === undefined ? {} : { minConfidence: p.minConfidence as number }),
    ...(p.service === undefined ? {} : { service: p.service as string }),
    ...(p.explain === true ? { explain: true } : {}),
  };
}

async function handleDecisions(
  params: unknown,
  ctx: AgentsRpcContext,
): Promise<{ sessionId: string }> {
  const input = requireDecisionsParams(params);
  return await emitDecisionsBrief(input, {
    db: ctx.db,
    notify: ctx.notify,
    sessionId: newSessionId("decisions"),
    ...(ctx.llm === undefined ? {} : { llm: ctx.llm }),
  });
}
```

Add `"agents.decisions": handleDecisions,` to the dispatch map, and add `| "decisions"` to the session-kind union at ~line 187.

- [ ] **Step 4: Update the Tauri allowlist (invariant I7)**

In `packages/ui/src-tauri/src/gateway_bridge.rs`, add `"agents.decisions",` beside `"agents.glossary",` and change the count assertion at line 519 from `102` to `103`. **Both edits land in the same commit** — that is the invariant triple rule, and a count mismatch fails the Rust test.

The method is safe to expose: it is a read-only agent with no dispatch, no write route and no HITL action type.

- [ ] **Step 5: Run the tests**

```bash
bun test packages/gateway/src/ipc/agents-rpc.test.ts
bun test packages/gateway/src/security-invariants.test.ts
```

Expected: PASS. If a Rust toolchain is available, also run `cargo test --manifest-path packages/ui/src-tauri/Cargo.toml allowed_methods`; if not, note that CI covers it — do not skip the count edit on that basis.

- [ ] **Step 6: Commit**

```bash
git add packages/gateway/src/ipc/agents-rpc.ts \
        packages/gateway/src/ipc/agents-rpc.test.ts \
        packages/ui/src-tauri/src/gateway_bridge.rs
git commit -m "feat(decisions): expose agents.decisions over IPC and the Tauri allowlist (I7 102 to 103)"
```

---

## Task 15: The CLI

**Files:**
- Modify: `packages/cli/src/lib/parse-duration.ts` and `parse-duration.test.ts`
- Create: `packages/cli/src/commands/decisions.ts`
- Create: `packages/cli/src/commands/decisions.test.ts`
- Modify: `packages/cli/src/index.ts` (command registry, beside `glossary: runGlossaryCommand` ~line 100)

**Interfaces:**
- Consumes: `runAgentBriefCli`, `flagValue`, `TIMEOUT_MS` from `./_agent-brief-cli.ts`; `parseDurationToMs`.
- Produces: `parseDecisionsArgs(args: string[]): DecisionsCliArgs`, `isDecisionsBriefLike(v): v is DecisionsBriefLike`, `runDecisionsCommand(args: string[]): Promise<void>`.

**Note:** the CLI cannot import gateway source (IPC-only rule). Define a local structural `DecisionsBriefLike` guard, exactly as `commands/glossary.ts` does.

- [ ] **Step 1: Write the failing duration test**

Add to `packages/cli/src/lib/parse-duration.test.ts`:

```typescript
test("accepts day and week units", () => {
  expect(parseDurationToMs("90d")).toBe(90 * 24 * 60 * 60 * 1000);
  expect(parseDurationToMs("2w")).toBe(2 * 7 * 24 * 60 * 60 * 1000);
});

test("still rejects an unknown unit", () => {
  expect(() => parseDurationToMs("90x")).toThrow();
});

test("pre-existing units are unchanged", () => {
  expect(parseDurationToMs("30s")).toBe(30_000);
  expect(parseDurationToMs("5m")).toBe(300_000);
  expect(parseDurationToMs("1h")).toBe(3_600_000);
  expect(parseDurationToMs("250ms")).toBe(250);
});
```

- [ ] **Step 2: Run it to verify it fails**

```bash
bun test packages/cli/src/lib/parse-duration.test.ts
```

Expected: FAIL on `90d` — `Invalid duration "90d"`.

- [ ] **Step 3: Extend the helper**

In `parse-duration.ts` change the regex to `/^(\d+)\s*(ms|s|m|h|d|w)$/i`, add the two `switch` cases, and update the error message to `(use e.g. 5m, 1h, 90d)`. The change is purely additive — input that was an error becomes valid — so the existing `connector` and `share` callers are unaffected.

- [ ] **Step 4: Run it to verify it passes**

```bash
bun test packages/cli/src/lib/parse-duration.test.ts
```

Expected: PASS.

- [ ] **Step 5: Write the failing CLI arg test**

Create `packages/cli/src/commands/decisions.test.ts`:

```typescript
import { expect, test } from "bun:test";

import { isDecisionsBriefLike, parseDecisionsArgs } from "./decisions.ts";

test("defaults to a 90-day window", () => {
  expect(parseDecisionsArgs([]).sinceMs).toBe(90 * 24 * 60 * 60 * 1000);
});

test("parses --since with a day unit", () => {
  expect(parseDecisionsArgs(["--since", "30d"]).sinceMs).toBe(30 * 24 * 60 * 60 * 1000);
});

test("parses --service, --min-confidence, --explain and --json", () => {
  const a = parseDecisionsArgs(["--service", "billing", "--min-confidence", "0.6", "--explain", "--json"]);
  expect(a.service).toBe("billing");
  expect(a.minConfidence).toBeCloseTo(0.6, 5);
  expect(a.explain).toBe(true);
  expect(a.json).toBe(true);
});

test("rejects a min-confidence outside 0..1", () => {
  expect(() => parseDecisionsArgs(["--min-confidence", "2"])).toThrow();
});

test("rejects --since with no value", () => {
  expect(() => parseDecisionsArgs(["--since"])).toThrow();
});

test("rejects combining --refresh and --rebuild", () => {
  expect(() => parseDecisionsArgs(["--refresh", "--rebuild"])).toThrow();
});

test("the brief guard accepts a well-formed payload and rejects junk", () => {
  expect(isDecisionsBriefLike({ kind: "decisions", entries: [], gaps: [] })).toBe(true);
  expect(isDecisionsBriefLike({ kind: "glossary", entries: [], gaps: [] })).toBe(false);
  expect(isDecisionsBriefLike(null)).toBe(false);
});
```

- [ ] **Step 6: Run it to verify it fails**

```bash
bun test packages/cli/src/commands/decisions.test.ts
```

Expected: FAIL — module not found.

- [ ] **Step 7: Write the command**

Create `commands/decisions.ts` following `commands/glossary.ts` closely — it already implements `--refresh` and `--rebuild` with a `--yes` confirm, and owns the `beforeCall` hook that runs a long pass before the 30 s brief timer is armed. Reuse that hook for `--refresh` / `--rebuild`; without it a multi-minute pass is killed by the brief timeout.

Usage string:

```
Usage: nimbus decisions [--since <duration>] [--service <name>] [--min-confidence <0..1>]
                        [--explain] [--json] [--refresh | --rebuild [--yes]]
```

- [ ] **Step 8: Register the command**

In `packages/cli/src/index.ts` add `decisions: runDecisionsCommand,` beside the `glossary` entry, keeping the registry's existing ordering convention.

- [ ] **Step 9: Run the tests**

```bash
bun test packages/cli/src/commands/decisions.test.ts
bun test packages/cli/src/commands/help.test.ts
```

Expected: PASS. `help.test.ts` may assert a command count or a sorted list — if it fails, update the expectation, since a new command is exactly what changed.

- [ ] **Step 10: Commit**

```bash
git add packages/cli/src/lib/parse-duration.ts packages/cli/src/lib/parse-duration.test.ts \
        packages/cli/src/commands/decisions.ts packages/cli/src/commands/decisions.test.ts \
        packages/cli/src/index.ts
git commit -m "feat(decisions): add the nimbus decisions CLI and day/week duration units"
```

---

## Task 16: E2E, docs, and the full gate

**Files:**
- Create: `packages/gateway/test/e2e/scenarios/decisions.e2e.test.ts`
- Modify: `docs/CHANGELOG.md`
- Modify: `docs/roadmap.md` (Wave 5 row + the S1 Active section)
- Modify: `docs/cli-reference.md`
- Modify: `CLAUDE.md` and `GEMINI.md` (schema V46 → V47; both files must stay in sync)

**Interfaces:**
- Consumes: everything.
- Produces: no new exports.

- [ ] **Step 1: Write the e2e test**

Create `packages/gateway/test/e2e/scenarios/decisions.e2e.test.ts`, modelled on `expert.e2e.test.ts`. It must cover:

```typescript
test("the decisions agent source is read-only", async () => {
  const src = await Bun.file("packages/gateway/src/agents/decisions.ts").text();
  expect(src).not.toContain("ToolExecutor");
  expect(src).not.toContain("HITL_REQUIRED");
  expect(src).not.toContain("connectors.dispatch");
});
```

Plus: a seeded index → pass → `emitDecisionsBrief` run that asserts `decisions.briefReady` fires with a non-empty Markdown `brief` and a `findings.kind === "decisions"`.

**On the read-only assert:** assert on the exact import/reference text, and red-prove it — temporarily add `import type { ToolExecutor }` to the agent, confirm the test fails, then remove it. A guard that has never been seen to fail is not a guard.

- [ ] **Step 2: Run the e2e test**

```bash
bun test packages/gateway/test/e2e/scenarios/decisions.e2e.test.ts
```

Expected: PASS.

- [ ] **Step 3: Update the docs**

- `docs/CHANGELOG.md` — a dated entry under today's date. This is the canonical delivery log; connector/feature deliveries go here, **not** in the CLAUDE.md status line.
- `docs/roadmap.md` — tick the Wave 5 `nimbus decisions` row with the date and a one-line summary; move it from "Remaining in S1" to "Delivered so far" in the Active section.
- `docs/cli-reference.md` — add the `nimbus decisions` subcommand. A doc naming a `nimbus <cmd>` absent from the CLI registry fails `audit:readme-cli`, and the reverse drift fails too.
- `CLAUDE.md` **and** `GEMINI.md` — schema `V46` → `V47`. `GEMINI.md` mirrors `CLAUDE.md`; updating one and not the other is a drift the doc-status gate catches.

- [ ] **Step 4: Run the fast preflight**

```bash
bun run preflight:fast
```

Expected: PASS. This covers types, lint and the static structure audits (I14/D12 among them).

**Do not pipe this to `tail`** — a piped command reports the pipe's exit code, not the gate's, and this repo has a recorded incident of a "passing" run that had actually failed. Redirect to a file and check the status, or read the output directly.

- [ ] **Step 5: Run the full preflight**

```bash
bun run preflight
```

Expected: PASS. `test:ci` alone is **not** the full gate set — `preflight` is.

If `audit:coverage-floor` fails, note that it is **CI-Linux-authoritative**: reproduce under Docker `oven/bun:1.3` before changing anything, and do not chase a Windows-local number. Every new file under `packages/gateway/src/decisions/` must clear the ≥80%/file line+branch floor.

- [ ] **Step 6: Commit**

```bash
git add packages/gateway/test/e2e/scenarios/decisions.e2e.test.ts \
        docs/CHANGELOG.md docs/roadmap.md docs/cli-reference.md CLAUDE.md GEMINI.md
git commit -m "test(decisions): add the e2e scenario and update the roadmap, changelog and CLI reference"
```

- [ ] **Step 7: Push and open the PR**

```bash
git push -u origin dev/asafgolombek/nimbus-decisions
```

**The PR title and description ARE the commit** — squash is the only merge method here, and local commit messages are discarded. Put the conventional-commit type in the title, because release-please parses that subject line for the version bump:

> `feat(decisions): add nimbus decisions, the implicit ADR extractor`

Put the reasoning in the description. Do **not** leave a bare `Release-As:` line in it unless a forced version bump is intended.

---

## Notes for the implementer

**Things this codebase will bite you on, in rough order of likelihood:**

1. **Edit the worktree path, not the main checkout.** `.claude/worktrees/nimbus-decisions/...` — a main-repo path silently edits `main`.
2. **`bun run lint` reports 0 files inside `.claude/worktrees/`.** A clean lint run there may mean nothing ran. Trust CI, and run the gates from the main checkout path if a result looks suspiciously clean.
3. **Every SQLite write goes through `dbRun`.** A raw `db.run` in production code fails `audit:invariants`. Test files may use `db.run` for seeding — the audit scopes to `src/`.
4. **Never `db.prepare()` without `finalize()`.** Use `db.query()`. An unfinalized statement makes `db.close()` a silent no-op and produces `EBUSY` on Windows.
5. **Inject the LLM; never `mock.module` it.** `mock.module` leaks process-globally and is a known CI-Linux-only failure in the combined CLI test run.
6. **`git commit -m` eats backticks** via bash command substitution — the commit still succeeds, with text missing. Use `-F -` with a quoted heredoc for any message containing backticks.
7. **Don't pipe preflight to `tail`** — you will read the pipe's exit code, not the gate's.
8. **The I7 count assertion and the allowlist entry land in the same commit.** Splitting them leaves `main` red.
