# `nimbus glossary` Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship `nimbus glossary [<term>]` — a tenth built-in read-only agent plus a background extraction pass that mines domain terminology from the already-indexed graph into a new `glossary_term` item type.

**Architecture:** Two paths that must not be conflated. A **write path** (`packages/gateway/src/glossary/`) mines candidate terms deterministically from indexed item text, recomputes their statistics from the existing FTS index, consolidates the top-ranked ones through the local LLM, and projects them into the unified `item` table. A **read path** (`packages/gateway/src/agents/glossary.ts`) fans four `AgentCoordinator` lanes over the materialized tables and emits a `glossary.briefReady` notification. The pass is triggered off the existing `onConnectorSyncSuccess` seam — no new timer, no new lifecycle object.

**Tech Stack:** Bun v1.2+, TypeScript 6.x strict, `bun:sqlite`, Biome, `bun test`.

**Spec:** `docs/superpowers/specs/2026-07-30-nimbus-glossary-design.md` — read it before Task 1. Section references below (§5.1, §5.5, …) point into it.

## Global Constraints

- **No `any`.** Use `unknown` for external data. TypeScript strict mode is non-negotiable.
- **All SQLite writes go through `dbRun` / `dbExec` / `dbStmtRun`** from `packages/gateway/src/db/write.ts` (invariant **I14**, static check **D12**). A raw `db.run(...)` fails the preflight.
- **All SQL uses bound parameters.** Never interpolate values into SQL strings (**I9**).
- **`wrapToolOutput` wraps every string fed to the LLM** (**I11**), imported from `packages/gateway/src/engine/tool-output-envelope.ts`.
- **Read-only agent.** `agents/glossary.ts` must never import `ToolExecutor` or reference `HITL_REQUIRED`. No HITL action type is added.
- **Cross-platform paths** via `path.join()` — never hardcoded separators.
- **No new runtime dependencies.** Do not `bun add` anything; everything needed is already present.
- **Brief types stay local to the gateway in this slice.** `GlossaryBrief` is defined in `packages/gateway/src/agents/_lib/glossary-types.ts`, NOT added to `@nimbus-dev/sdk` (a separate published repo). This mirrors how `why` shipped: local types first, SDK promotion in a follow-up (#825). `findings.ts` is only a re-export shim for SDK types — do not add glossary types to it.
- **Default config values** (spec §7 plus two added in plan review): `enabled = true`, `max_new_terms_per_pass = 25`, `stats_recheck_per_pass = 50`, `stats_recheck_cooldown_ms = 43200000` (12 h), `min_doc_freq = 3`, `debounce_ms = 60000`, `consolidate_timeout_ms = 30000`, `retry_base_cooldown_ms = 900000` (15 min).
- **Coverage floor:** every new source file needs **≥80% line AND branch** coverage.
- **Commit on the branch** `dev/asafgolombek/nimbus-glossary` inside the worktree `.claude/worktrees/nimbus-glossary`. Never commit on `main`.
- **Run tests with** `bun test <path>` from the worktree root.
- **Migrations in tests:** there is no `runMigrations` export. The real API is
  `runIndexedSchemaMigrations(db, CURRENT_SCHEMA_VERSION)` from `index/migrations/runner.ts`, with
  `CURRENT_SCHEMA_VERSION` (already bumped to 45 by Task 1) in `index/local-index.ts`. Every test
  below defines a small local `runMigrations` wrapper around it — that is the repo-wide convention.

---

## File Structure

**Created — extraction (write path), `packages/gateway/src/glossary/`:**

| File | Responsibility |
| --- | --- |
| `glossary-types.ts` | Shared domain types for the write path |
| `stopwords.ts` | Static 3-layer stopword baseline |
| `term-normalize.ts` | Pure: surface form → `term_key` |
| `term-mining.ts` | Pure: text → candidate surface forms (5 families + family-5 guards) |
| `term-scoring.ts` | Pure: statistics → score |
| `near-miss.ts` | Pure: acronym↔expansion synonyms + edit-distance near-misses |
| `glossary-source-types.ts` | `GLOSSARY_SOURCE_TYPES` — which `service:type` keys feed mining |
| `glossary-store.ts` | V45 CRUD + the FTS statistics recompute |
| `glossary-project.ts` | Consolidated row → `nimbus:glossary_term` item, and its removal |
| `glossary-consolidate.ts` | LLM call, veto handling, timeout, snippet fallback |
| `glossary-reconcile.ts` | Pure-SQL reconciliation sweep (§5.5) |
| `glossary-extract.ts` | Two-phase pass orchestrator |
| `glossary-refresh.ts` | Debounced single-flight trigger |

**Created — read path:**

| File | Responsibility |
| --- | --- |
| `packages/gateway/src/index/glossary-v45-sql.ts` | V45 schema SQL |
| `packages/gateway/src/agents/_lib/glossary-types.ts` | `GlossaryBrief`, `GlossaryEntry`, `GlossaryInput` |
| `packages/gateway/src/agents/glossary.ts` | The 4-lane agent + `emitGlossaryBrief` |
| `packages/cli/src/commands/glossary.ts` | CLI entry point |

**Modified:**

| File | Change |
| --- | --- |
| `packages/gateway/src/index/migrations/runner.ts` | Register `simpleStep(44, 45, …)` |
| `packages/gateway/src/embedding/routing.ts` | `nimbus:glossary_term` → `PROSE_HEAVY_TYPES` |
| `packages/gateway/src/agents/_lib/render.ts` | `renderGlossary()` |
| `packages/gateway/src/agents/_lib/synthesize.ts` | `SynthInput` union + 2 switches |
| `packages/gateway/src/agents/_lib/emit-brief.ts` | `AnyBrief` union |
| `packages/gateway/src/config/nimbus-toml.ts` | `[glossary]` block |
| `packages/gateway/src/platform/assemble.ts` | Wire refresh into `onConnectorSyncSuccess` |
| `packages/gateway/src/ipc/*` | `agents.glossary` method |
| `packages/ui/src-tauri/src/gateway_bridge.rs` | `ALLOWED_METHODS` 101 → 102 |
| `packages/cli/src/index.ts` | Register the `glossary` command |

**Task dependency order:** 1 → (2,3) → 4 → (5,6) → 7 → 8 → 9 → 10 → 11 → 12 → 13 → 14 → 15 → 16 → 17.

---

### Task 1: V45 migration

**Files:**
- Create: `packages/gateway/src/index/glossary-v45-sql.ts`
- Modify: `packages/gateway/src/index/migrations/runner.ts`
- Test: `packages/gateway/src/index/migrations/runner-v45.test.ts`

**Interfaces:**
- Consumes: `simpleStep` from `runner.ts` (existing).
- Produces: `GLOSSARY_V45_SQL` — a `string` of `CREATE TABLE IF NOT EXISTS` statements. Tables `glossary_term` and `glossary_pass_state` exist at schema version 45.

- [ ] **Step 1: Read the existing V44 precedent**

Read `packages/gateway/src/index/egress-ledger-v44-sql.ts` and the tail of `packages/gateway/src/index/migrations/runner.ts` (around line 407). Match their export naming and registration style exactly.

- [ ] **Step 2: Write the failing test**

Create `packages/gateway/src/index/migrations/runner-v45.test.ts`:

```typescript
import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";

import { CURRENT_SCHEMA_VERSION } from "../local-index.ts";
import { runIndexedSchemaMigrations } from "./runner.ts";

/** There is no `runMigrations` export — this wrapper matches every other test in the repo. */
function runMigrations(db: Database): void {
  runIndexedSchemaMigrations(db, CURRENT_SCHEMA_VERSION);
}

function tableExists(db: Database, name: string): boolean {
  const row = db
    .query("SELECT name FROM sqlite_master WHERE type='table' AND name = ?")
    .get(name) as { name: string } | null;
  return row !== null;
}

test("V45 creates glossary_term and glossary_pass_state", () => {
  const db = new Database(":memory:");
  runMigrations(db);
  expect(tableExists(db, "glossary_term")).toBe(true);
  expect(tableExists(db, "glossary_pass_state")).toBe(true);
  db.close();
});

test("V45 glossary_term rejects an unknown status", () => {
  const db = new Database(":memory:");
  runMigrations(db);
  expect(() =>
    db.run(
      `INSERT INTO glossary_term (term_key, display_term, status, first_seen_at, last_seen_at, updated_at)
       VALUES ('x', 'X', 'bogus', 0, 0, 0)`,
    ),
  ).toThrow();
  db.close();
});

test("V45 glossary_pass_state is single-row", () => {
  const db = new Database(":memory:");
  runMigrations(db);
  db.run("INSERT INTO glossary_pass_state (id, watermark_ms) VALUES (1, 5)");
  expect(() => db.run("INSERT INTO glossary_pass_state (id, watermark_ms) VALUES (2, 5)")).toThrow();
  db.close();
});

test("V45 is idempotent across a second migration run", () => {
  const db = new Database(":memory:");
  runMigrations(db);
  runMigrations(db);
  expect(tableExists(db, "glossary_term")).toBe(true);
  db.close();
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `bun test packages/gateway/src/index/migrations/runner-v45.test.ts`
Expected: FAIL — `glossary_term` does not exist.

- [ ] **Step 4: Write the schema SQL**

Create `packages/gateway/src/index/glossary-v45-sql.ts`:

```typescript
/**
 * V45 — glossary_term + glossary_pass_state (implicit-knowledge glossary).
 *
 * `glossary_term` is the SSoT for the extraction pass: it holds candidates in
 * every status, including `pending` work not yet consolidated and `vetoed`
 * rejections that must never be re-asked. Only `consolidated` rows are
 * projected into the searchable `item` table.
 *
 * `first_seen_at` / `last_seen_at` are CONTENT dates — the min/max
 * `item.modified_at` across citing items — not row timestamps. They are
 * recomputed, never stamped on insert.
 *
 * `stats_verified_at` drives the reconciliation sweep: terms are re-verified
 * round-robin oldest-first so that a term whose sources were deleted is
 * eventually demoted rather than lingering with inflated statistics.
 *
 * `attempts` / `last_attempt_at` prevent head-of-line blocking in the
 * consolidation queue. The queue is ordered by score, and a failed
 * consolidation leaves the row `pending` — so without a backoff the same
 * high-scoring failures would be re-selected every pass forever and no
 * lower-scoring term would ever consolidate. Some failures are PERMANENT
 * (e.g. in snippet mode, a term whose sources never state it in a full
 * sentence), so this is starvation by construction, not a rare race.
 */
export const GLOSSARY_V45_SQL = `
CREATE TABLE IF NOT EXISTS glossary_term (
  term_key          TEXT PRIMARY KEY,
  display_term      TEXT NOT NULL,
  status            TEXT NOT NULL CHECK(status IN ('pending','consolidated','vetoed')),
  definition        TEXT,
  definition_source TEXT CHECK(definition_source IN ('llm','snippet')),
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
  updated_at        INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_glossary_term_status_score
  ON glossary_term(status, score DESC);
CREATE INDEX IF NOT EXISTS idx_glossary_term_pending_attempt
  ON glossary_term(status, last_attempt_at);
CREATE INDEX IF NOT EXISTS idx_glossary_term_display
  ON glossary_term(display_term);
CREATE INDEX IF NOT EXISTS idx_glossary_term_verified
  ON glossary_term(status, stats_verified_at);

CREATE TABLE IF NOT EXISTS glossary_pass_state (
  id            INTEGER PRIMARY KEY CHECK(id = 1),
  watermark_ms  INTEGER NOT NULL DEFAULT 0,
  last_pass_at  INTEGER,
  last_pass_new INTEGER NOT NULL DEFAULT 0,
  scanned_items INTEGER NOT NULL DEFAULT 0
);
`;
```

Note the extra `form` column beyond the spec table: the scorer needs the candidate's form boost on re-score during reconciliation, and re-deriving it from the surface string would duplicate mining logic.

- [ ] **Step 5: Register the migration step**

In `packages/gateway/src/index/migrations/runner.ts`, add the import alongside the other `*-sql.ts` imports:

```typescript
import { GLOSSARY_V45_SQL } from "../glossary-v45-sql.ts";
```

Then append to the steps array, immediately after the `simpleStep(43, 44, …)` line:

```typescript
  simpleStep(44, 45, "glossary_term + glossary_pass_state (implicit-knowledge glossary v45)", GLOSSARY_V45_SQL),
```

- [ ] **Step 6: Run the test to verify it passes**

Run: `bun test packages/gateway/src/index/migrations/runner-v45.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 7: Run the full migration suite for regressions**

Run: `bun test packages/gateway/src/index/migrations/`
Expected: PASS. If a test asserts a specific latest-schema-version number, update it to 45.

- [ ] **Step 8: Commit**

```bash
git add packages/gateway/src/index/glossary-v45-sql.ts packages/gateway/src/index/migrations/
git commit -m "feat(glossary): V45 glossary_term + glossary_pass_state schema"
```

---

### Task 2: Stopwords baseline

**Files:**
- Create: `packages/gateway/src/glossary/stopwords.ts`
- Test: `packages/gateway/src/glossary/stopwords.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `isStopword(termKey: string): boolean`, `isFunctionWord(word: string): boolean`, `STOPWORDS: ReadonlySet<string>`. All inputs are expected already lowercased by the caller.

- [ ] **Step 1: Write the failing test**

Create `packages/gateway/src/glossary/stopwords.test.ts`:

```typescript
import { expect, test } from "bun:test";

import { isFunctionWord, isStopword, STOPWORDS } from "./stopwords.ts";

test("layer 1 — common English is a stopword", () => {
  expect(isStopword("the")).toBe(true);
  expect(isStopword("and")).toBe(true);
});

test("layer 2 — ubiquitous tech vocabulary is a stopword", () => {
  for (const t of ["api", "http", "json", "todo", "pr", "ci", "sdk", "url"]) {
    expect(isStopword(t)).toBe(true);
  }
});

test("layer 3 — language keywords are stopwords", () => {
  for (const t of ["const", "import", "return", "async", "await", "function", "class", "interface", "struct", "impl", "def", "select", "where", "null"]) {
    expect(isStopword(t)).toBe(true);
  }
});

test("real domain jargon is NOT a stopword", () => {
  for (const t of ["cdr", "shadow traffic", "retry budget", "shard_key"]) {
    expect(isStopword(t)).toBe(false);
  }
});

test("isFunctionWord covers articles, prepositions, conjunctions and pronouns", () => {
  for (const w of ["the", "a", "an", "in", "on", "at", "of", "for", "and", "or", "but", "it", "we", "they"]) {
    expect(isFunctionWord(w)).toBe(true);
  }
  expect(isFunctionWord("shadow")).toBe(false);
});

test("lookups are case-insensitive on already-lowercased input only", () => {
  expect(isStopword("const")).toBe(true);
  expect(isStopword("CONST")).toBe(false);
});

test("STOPWORDS covers all three layers at a meaningful size", () => {
  expect(STOPWORDS.size).toBeGreaterThan(100);
  // One representative per layer, proving the set is actually composed of all
  // three rather than one layer repeated.
  expect(STOPWORDS.has("the")).toBe(true);
  expect(STOPWORDS.has("json")).toBe(true);
  expect(STOPWORDS.has("impl")).toBe(true);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun test packages/gateway/src/glossary/stopwords.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the module**

Create `packages/gateway/src/glossary/stopwords.ts`:

```typescript
/**
 * Three-layer stopword baseline for glossary mining.
 *
 * Layer 3 (language keywords) exists specifically because mining family 2
 * harvests backticked tokens, and indexed commit messages, ADRs and technical
 * pages are dense with `const`-style syntax quoting. Without it the pending
 * queue fills with language syntax that then spends real LLM calls earning a
 * veto.
 *
 * Callers pass already-lowercased keys (see `normalizeTerm`).
 */

/** Articles, prepositions, conjunctions, pronouns — also used for family-5 phrase rejection. */
const FUNCTION_WORDS: readonly string[] = [
  "a", "an", "the", "this", "that", "these", "those",
  "in", "on", "at", "to", "from", "of", "for", "with", "by", "as", "into",
  "over", "under", "after", "before", "during", "about", "against", "between",
  "and", "or", "but", "nor", "so", "yet", "if", "then", "than", "because",
  "i", "we", "you", "he", "she", "it", "they", "them", "us", "our", "your",
  "their", "its", "his", "her", "my", "me", "who", "what", "when", "where",
  "why", "how", "all", "any", "both", "each", "few", "more", "most", "some",
  "such", "no", "not", "only", "own", "same", "too", "very", "can", "will",
  "just", "is", "are", "was", "were", "be", "been", "being", "have", "has",
  "had", "do", "does", "did", "would", "should", "could", "may", "might",
  "must", "shall", "there", "here", "now", "also", "still", "already",
];

const COMMON_ENGLISH: readonly string[] = [
  ...FUNCTION_WORDS,
  "new", "old", "next", "last", "first", "second", "good", "bad", "best",
  "one", "two", "three", "many", "much", "other", "another", "thing", "way",
  "time", "day", "week", "month", "year", "today", "yesterday", "tomorrow",
  "please", "thanks", "hi", "hey", "hello", "note", "notes", "update",
  "updates", "issue", "issues", "change", "changes", "work", "team", "user",
  "users", "data", "file", "files", "code", "test", "tests", "run", "add",
];

const UBIQUITOUS_TECH: readonly string[] = [
  "api", "apis", "http", "https", "json", "yaml", "xml", "html", "css",
  "todo", "fixme", "pr", "prs", "ci", "cd", "sdk", "url", "uri", "id", "ids",
  "ui", "ux", "db", "sql", "cli", "os", "vm", "aws", "gcp", "npm", "git",
  "repo", "repos", "branch", "commit", "merge", "rebase", "deploy", "build",
  "log", "logs", "error", "errors", "bug", "bugs", "fix", "fixes", "release",
];

const LANGUAGE_KEYWORDS: readonly string[] = [
  // TS / JS
  "const", "let", "var", "function", "class", "interface", "type", "enum",
  "import", "export", "default", "return", "async", "await", "yield", "new",
  "extends", "implements", "public", "private", "protected", "static",
  "readonly", "typeof", "instanceof", "void", "null", "undefined", "true",
  "false", "throw", "catch", "finally", "try", "switch", "case", "break",
  "continue", "while", "for", "else", "delete", "super", "this",
  // Python
  "def", "elif", "lambda", "pass", "raise", "except", "yield", "global",
  "nonlocal", "assert", "del", "none",
  // Go
  "func", "package", "defer", "chan", "range", "struct", "map", "go", "select",
  // Rust
  "fn", "impl", "trait", "mut", "pub", "crate", "match", "unsafe", "dyn",
  "where", "mod", "use", "self",
  // SQL
  "insert", "delete", "table", "index", "join", "group", "order", "limit",
  "values", "primary", "foreign", "unique",
  // Shell
  "echo", "cd", "ls", "cat", "grep", "sed", "awk", "sudo", "chmod",
];

export const STOPWORDS: ReadonlySet<string> = new Set([
  ...COMMON_ENGLISH,
  ...UBIQUITOUS_TECH,
  ...LANGUAGE_KEYWORDS,
]);

const FUNCTION_WORD_SET: ReadonlySet<string> = new Set(FUNCTION_WORDS);

/** True when the already-lowercased key carries no team-specific meaning. */
export function isStopword(termKey: string): boolean {
  return STOPWORDS.has(termKey);
}

/** True for articles / prepositions / conjunctions / pronouns. Drives family-5 rejection. */
export function isFunctionWord(word: string): boolean {
  return FUNCTION_WORD_SET.has(word);
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `bun test packages/gateway/src/glossary/stopwords.test.ts`
Expected: PASS (7 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/gateway/src/glossary/stopwords.ts packages/gateway/src/glossary/stopwords.test.ts
git commit -m "feat(glossary): three-layer stopword baseline"
```

---

### Task 3: Term normalization

**Files:**
- Create: `packages/gateway/src/glossary/term-normalize.ts`
- Test: `packages/gateway/src/glossary/term-normalize.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `normalizeTerm(surface: string): string` — returns the `term_key` (lowercased, backticks stripped, whitespace collapsed, trailing plural removed). Returns `""` for input that normalizes to nothing; callers MUST treat `""` as "not a term".

- [ ] **Step 1: Write the failing test**

Create `packages/gateway/src/glossary/term-normalize.test.ts`:

```typescript
import { expect, test } from "bun:test";

import { normalizeTerm } from "./term-normalize.ts";

test("lowercases", () => {
  expect(normalizeTerm("CDR")).toBe("cdr");
  expect(normalizeTerm("Shadow Traffic")).toBe("shadow traffic");
});

test("strips backticks and surrounding punctuation", () => {
  expect(normalizeTerm("`shard_key`")).toBe("shard_key");
  expect(normalizeTerm("(CDR)")).toBe("cdr");
  expect(normalizeTerm("CDR,")).toBe("cdr");
});

test("collapses internal whitespace", () => {
  expect(normalizeTerm("Shadow   Traffic")).toBe("shadow traffic");
  expect(normalizeTerm("  CDR  ")).toBe("cdr");
});

test("removes a trailing plural s", () => {
  expect(normalizeTerm("SLOs")).toBe("slo");
  expect(normalizeTerm("CDRs")).toBe("cdr");
});

test("does not strip s from a short or ss-ending word", () => {
  expect(normalizeTerm("as")).toBe("as");
  expect(normalizeTerm("class")).toBe("class");
  expect(normalizeTerm("status")).toBe("status");
});

test("plural and singular collapse to one key", () => {
  expect(normalizeTerm("SLOs")).toBe(normalizeTerm("SLO"));
});

test("returns empty string for meaningless input", () => {
  expect(normalizeTerm("")).toBe("");
  expect(normalizeTerm("   ")).toBe("");
  expect(normalizeTerm("``")).toBe("");
  expect(normalizeTerm("-")).toBe("");
});

test("preserves internal underscores and hyphens", () => {
  expect(normalizeTerm("shard_key")).toBe("shard_key");
  expect(normalizeTerm("write-behind")).toBe("write-behind");
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun test packages/gateway/src/glossary/term-normalize.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the module**

Create `packages/gateway/src/glossary/term-normalize.ts`:

```typescript
/**
 * Surface form -> `term_key`.
 *
 * The key is what collapses "SLO", "SLOs" and "slo" into a single glossary
 * entry, so it must be stable across every mining family. Depluralization is
 * deliberately conservative: stripping `s` from short words or `ss`/`us`
 * endings would merge unrelated terms ("class" -> "clas").
 */

/** Leading/trailing punctuation that clings to a term in prose. */
const EDGE_PUNCT = /^[`"'“”‘’([{<.,;:!?\-–—]+|[`"'“”‘’)\]}>.,;:!?\-–—]+$/g;

const MIN_DEPLURAL_LENGTH = 3;

function depluralize(word: string): string {
  if (word.length <= MIN_DEPLURAL_LENGTH) return word;
  if (!word.endsWith("s")) return word;
  if (word.endsWith("ss") || word.endsWith("us") || word.endsWith("is")) return word;
  return word.slice(0, -1);
}

/**
 * Returns the normalized key, or `""` when the input carries no term.
 * Callers MUST treat `""` as "not a term" rather than storing it.
 */
export function normalizeTerm(surface: string): string {
  const collapsed = surface.replace(/\s+/g, " ").trim();
  if (collapsed === "") return "";

  const words = collapsed
    .split(" ")
    .map((w) => w.replace(EDGE_PUNCT, ""))
    .filter((w) => w !== "");
  if (words.length === 0) return "";

  const lowered = words.map((w) => w.toLowerCase());
  const last = lowered[lowered.length - 1];
  if (last === undefined) return "";
  lowered[lowered.length - 1] = depluralize(last);

  const key = lowered.join(" ").trim();
  return key;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `bun test packages/gateway/src/glossary/term-normalize.test.ts`
Expected: PASS (8 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/gateway/src/glossary/term-normalize.ts packages/gateway/src/glossary/term-normalize.test.ts
git commit -m "feat(glossary): term normalization to a stable term_key"
```

---

### Task 4: Candidate mining

**Files:**
- Create: `packages/gateway/src/glossary/glossary-types.ts`
- Create: `packages/gateway/src/glossary/term-mining.ts`
- Test: `packages/gateway/src/glossary/term-mining.test.ts`

**Interfaces:**
- Consumes: `isFunctionWord`, `isStopword` (Task 2); `normalizeTerm` (Task 3).
- Produces:
  - `type CandidateForm = "acronym" | "code" | "identifier" | "hyphenated" | "phrase"`
  - `type MinedCandidate = { key: string; surface: string; form: CandidateForm; sentenceInitial: boolean }`
  - `mineTerms(text: string): MinedCandidate[]` — deduplicated by `key`, keeping the first surface seen. A candidate is `sentenceInitial: true` only when EVERY occurrence started a sentence.

- [ ] **Step 1: Write the failing test**

Create `packages/gateway/src/glossary/term-mining.test.ts`:

```typescript
import { expect, test } from "bun:test";

import { mineTerms } from "./term-mining.ts";

function keys(text: string): string[] {
  return mineTerms(text).map((c) => c.key).sort();
}

test("family 1 — mines acronyms", () => {
  expect(keys("We ship CDR nightly")).toContain("cdr");
});

test("family 1 — plural acronym collapses to the singular key", () => {
  expect(keys("our SLOs slipped")).toContain("slo");
});

test("family 2 — mines backticked tokens", () => {
  expect(keys("set the `shard_key` first")).toContain("shard_key");
});

test("family 3 — mines PascalCase and camelCase identifiers", () => {
  const k = keys("the RetryBudget guards retryPolicy");
  expect(k).toContain("retrybudget");
  expect(k).toContain("retrypolicy");
});

test("family 4 — mines hyphenated compounds", () => {
  expect(keys("we use write-behind caching")).toContain("write-behind");
});

test("family 5 — mines a mid-sentence capitalized phrase", () => {
  expect(keys("we route Shadow Traffic to staging")).toContain("shadow traffic");
});

test("family 5 — rejects a phrase containing a function word", () => {
  expect(keys("In Addition we shipped")).not.toContain("in addition");
});

test("family 5 — a sentence-initial-only phrase is flagged, not silently kept", () => {
  const c = mineTerms("The Target moved. Nobody noticed.").find((x) => x.key === "the target");
  expect(c).toBeUndefined();
});

test("family 5 — sentenceInitial is false when the phrase also appears mid-sentence", () => {
  const text = "Shadow Traffic is new. We route Shadow Traffic daily.";
  const c = mineTerms(text).find((x) => x.key === "shadow traffic");
  expect(c).toBeDefined();
  expect(c?.sentenceInitial).toBe(false);
});

test("stopwords are excluded", () => {
  const k = keys("the API returned JSON with `const` values");
  expect(k).not.toContain("api");
  expect(k).not.toContain("json");
  expect(k).not.toContain("const");
});

test("deduplicates repeated terms by key", () => {
  const found = mineTerms("CDR and CDR and CDRs").filter((c) => c.key === "cdr");
  expect(found.length).toBe(1);
});

test("empty and whitespace input yields no candidates", () => {
  expect(mineTerms("")).toEqual([]);
  expect(mineTerms("   \n  ")).toEqual([]);
});

test("unicode text does not throw", () => {
  expect(() => mineTerms("émission CDR — naïve café")).not.toThrow();
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun test packages/gateway/src/glossary/term-mining.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the shared types module**

Create `packages/gateway/src/glossary/glossary-types.ts`:

```typescript
/** Which mining family produced a candidate. Drives the scoring form boost. */
export type CandidateForm = "acronym" | "code" | "identifier" | "hyphenated" | "phrase";

/** A candidate surface form discovered by mining, before any statistics are known. */
export type MinedCandidate = {
  /** Normalized key (see `normalizeTerm`). Never empty. */
  key: string;
  /** The surface form as written, used as `display_term`. */
  surface: string;
  form: CandidateForm;
  /** True only when EVERY observed occurrence began a sentence (family-5 guard). */
  sentenceInitial: boolean;
};

export type GlossaryStatus = "pending" | "consolidated" | "vetoed";

export type DefinitionSource = "llm" | "snippet";

/** One of the (max 5) most-cited items that evidence a term. */
export type GlossarySource = {
  itemId: string;
  title: string;
  url: string | null;
  service: string;
  modifiedAt: number;
};

/** Statistics recomputed from the FTS index — never accumulated. */
export type TermStats = {
  docFreq: number;
  serviceSpread: number;
  firstSeenAt: number;
  lastSeenAt: number;
  topSources: GlossarySource[];
};

/** A `glossary_term` row in domain shape. */
export type GlossaryTerm = {
  termKey: string;
  displayTerm: string;
  status: GlossaryStatus;
  definition: string | null;
  definitionSource: DefinitionSource | null;
  docFreq: number;
  serviceSpread: number;
  score: number;
  form: CandidateForm;
  firstSeenAt: number;
  lastSeenAt: number;
  topSources: GlossarySource[];
  synonyms: string[];
  nearMisses: string[];
  consolidatedAt: number | null;
  statsVerifiedAt: number;
  updatedAt: number;
};
```

- [ ] **Step 4: Implement mining**

Create `packages/gateway/src/glossary/term-mining.ts`:

```typescript
import type { CandidateForm, MinedCandidate } from "./glossary-types.ts";
import { isFunctionWord, isStopword } from "./stopwords.ts";
import { normalizeTerm } from "./term-normalize.ts";

/**
 * Deterministic candidate mining over indexed item text (title + the 512-char
 * body preview).
 *
 * Family 5 (capitalized phrases) is the noisiest by far, because English
 * capitalizes the first word of every sentence. Two guards apply: any phrase
 * containing a function word is rejected outright, and a phrase seen ONLY in
 * sentence-initial position is dropped — real terminology appears
 * mid-sentence routinely, sentence openers essentially never do.
 */

const ACRONYM_RE = /\b[A-Z]{2,6}s?\b/g;
const CODE_RE = /`([^`\n]{2,60})`/g;
const IDENTIFIER_RE = /\b[a-z]+[A-Z][A-Za-z0-9]*\b|\b[A-Z][a-z0-9]+[A-Z][A-Za-z0-9]*\b/g;
const HYPHENATED_RE = /\b[a-z]{2,}(?:-[a-z]{2,}){1,3}\b/g;
const PHRASE_RE = /\b[A-Z][a-z0-9]+(?:\s+[A-Z][a-z0-9]+){1,3}\b/g;

/** End-of-sentence punctuation followed by whitespace. */
const SENTENCE_SPLIT = /(?<=[.!?])\s+/;

type Hit = { surface: string; form: CandidateForm; sentenceInitial: boolean };

function collect(re: RegExp, text: string, form: CandidateForm, group = 0): Hit[] {
  const out: Hit[] = [];
  re.lastIndex = 0;
  let m: RegExpExecArray | null = re.exec(text);
  while (m !== null) {
    const surface = m[group];
    if (surface !== undefined && surface.trim() !== "") {
      out.push({ surface, form, sentenceInitial: false });
    }
    m = re.exec(text);
  }
  return out;
}

/** Phrases carry position information, so they are mined sentence by sentence. */
function collectPhrases(text: string): Hit[] {
  const out: Hit[] = [];
  for (const sentence of text.split(SENTENCE_SPLIT)) {
    const trimmed = sentence.trim();
    if (trimmed === "") continue;
    PHRASE_RE.lastIndex = 0;
    let m: RegExpExecArray | null = PHRASE_RE.exec(trimmed);
    while (m !== null) {
      const surface = m[0];
      out.push({ surface, form: "phrase", sentenceInitial: m.index === 0 });
      m = PHRASE_RE.exec(trimmed);
    }
  }
  return out;
}

function phraseRejected(surface: string): boolean {
  return surface.split(/\s+/).some((w) => isFunctionWord(w.toLowerCase()));
}

export function mineTerms(text: string): MinedCandidate[] {
  if (text.trim() === "") return [];

  const hits: Hit[] = [
    ...collect(ACRONYM_RE, text, "acronym"),
    ...collect(CODE_RE, text, "code", 1),
    ...collect(IDENTIFIER_RE, text, "identifier"),
    ...collect(HYPHENATED_RE, text, "hyphenated"),
    ...collectPhrases(text),
  ];

  const byKey = new Map<string, MinedCandidate>();
  for (const hit of hits) {
    if (hit.form === "phrase" && phraseRejected(hit.surface)) continue;

    const key = normalizeTerm(hit.surface);
    if (key === "" || isStopword(key)) continue;

    const existing = byKey.get(key);
    if (existing === undefined) {
      byKey.set(key, {
        key,
        surface: hit.surface,
        form: hit.form,
        sentenceInitial: hit.sentenceInitial,
      });
      continue;
    }
    // A single mid-sentence sighting clears the sentence-initial flag for good.
    if (!hit.sentenceInitial) {
      byKey.set(key, { ...existing, sentenceInitial: false });
    }
  }

  // Drop phrases that were ONLY ever sentence-initial (see the module note).
  return [...byKey.values()].filter((c) => !(c.form === "phrase" && c.sentenceInitial));
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `bun test packages/gateway/src/glossary/term-mining.test.ts`
Expected: PASS (13 tests). If the identifier family also matches inside phrases, that is fine — dedup by key resolves it.

- [ ] **Step 6: Commit**

```bash
git add packages/gateway/src/glossary/glossary-types.ts packages/gateway/src/glossary/term-mining.ts packages/gateway/src/glossary/term-mining.test.ts
git commit -m "feat(glossary): deterministic candidate mining with family-5 guards"
```

---

### Task 5: Scoring

**Files:**
- Create: `packages/gateway/src/glossary/term-scoring.ts`
- Test: `packages/gateway/src/glossary/term-scoring.test.ts`

**Interfaces:**
- Consumes: `CandidateForm` (Task 4).
- Produces: `FORM_BOOST: Record<CandidateForm, number>`, `scoreTerm(input: { docFreq: number; serviceSpread: number; form: CandidateForm }): number`.

- [ ] **Step 1: Write the failing test**

Create `packages/gateway/src/glossary/term-scoring.test.ts`:

```typescript
import { expect, test } from "bun:test";

import { FORM_BOOST, scoreTerm } from "./term-scoring.ts";

test("score rises with document frequency", () => {
  const low = scoreTerm({ docFreq: 3, serviceSpread: 1, form: "phrase" });
  const high = scoreTerm({ docFreq: 30, serviceSpread: 1, form: "phrase" });
  expect(high).toBeGreaterThan(low);
});

test("score rises with service spread at equal frequency", () => {
  const one = scoreTerm({ docFreq: 10, serviceSpread: 1, form: "phrase" });
  const three = scoreTerm({ docFreq: 10, serviceSpread: 3, form: "phrase" });
  expect(three).toBeGreaterThan(one);
});

test("acronyms outrank phrases at identical statistics", () => {
  const acronym = scoreTerm({ docFreq: 10, serviceSpread: 2, form: "acronym" });
  const phrase = scoreTerm({ docFreq: 10, serviceSpread: 2, form: "phrase" });
  expect(acronym).toBeGreaterThan(phrase);
});

test("form boosts are ordered acronym > code > identifier > hyphenated > phrase", () => {
  expect(FORM_BOOST.acronym).toBeGreaterThan(FORM_BOOST.code);
  expect(FORM_BOOST.code).toBeGreaterThan(FORM_BOOST.identifier);
  expect(FORM_BOOST.identifier).toBeGreaterThan(FORM_BOOST.hyphenated);
  expect(FORM_BOOST.hyphenated).toBeGreaterThan(FORM_BOOST.phrase);
});

test("zero frequency scores zero", () => {
  expect(scoreTerm({ docFreq: 0, serviceSpread: 0, form: "acronym" })).toBe(0);
});

test("a spread below one never reduces the score", () => {
  const s = scoreTerm({ docFreq: 5, serviceSpread: 0, form: "phrase" });
  expect(s).toBeGreaterThan(0);
});

test("score is finite for large inputs", () => {
  expect(Number.isFinite(scoreTerm({ docFreq: 1e6, serviceSpread: 50, form: "acronym" }))).toBe(true);
});

test("a cross-service term outranks a high-frequency single-channel term", () => {
  // The motivating case from the docstring, pinned with EXACT expected values.
  // The other tests here assert only relative ordering, so a coefficient change
  // that preserved monotonicity would slip past them — this one would not.
  const noisy = scoreTerm({ docFreq: 40, serviceSpread: 1, form: "phrase" });
  const crossService = scoreTerm({ docFreq: 10, serviceSpread: 2, form: "phrase" });
  expect(crossService).toBeGreaterThan(noisy);
  expect(noisy).toBeCloseTo(3.714, 2);
  expect(crossService).toBeCloseTo(3.836, 2);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun test packages/gateway/src/glossary/term-scoring.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the module**

Create `packages/gateway/src/glossary/term-scoring.ts`:

```typescript
import type { CandidateForm } from "./glossary-types.ts";

/**
 * Ranking for the consolidation queue.
 *
 * Spread across services is weighted deliberately: a term appearing in both
 * Slack AND Jira is far more likely to be real team vocabulary than one
 * appearing forty times in a single noisy channel.
 */
export const FORM_BOOST: Record<CandidateForm, number> = {
  acronym: 1.3,
  code: 1.2,
  identifier: 1.1,
  hyphenated: 1.05,
  phrase: 1.0,
};

/**
 * Spread grows GEOMETRICALLY, not linearly.
 *
 * A linear bonus does not actually deliver the intent above: with
 * `1 + 0.5*(spread-1)`, a term seen 40 times in one noisy channel scores 3.714
 * and beats a genuine two-service term at 3.597 — the precise case the
 * weighting exists to defeat. At base 1.6 the two-service term scores 3.836
 * and wins, while frequency still separates terms at equal spread.
 */
const SPREAD_BASE = 1.6;

export function scoreTerm(input: {
  docFreq: number;
  serviceSpread: number;
  form: CandidateForm;
}): number {
  if (input.docFreq <= 0) return 0;
  const spread = Math.max(1, input.serviceSpread);
  return Math.log1p(input.docFreq) * SPREAD_BASE ** (spread - 1) * FORM_BOOST[input.form];
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `bun test packages/gateway/src/glossary/term-scoring.test.ts`
Expected: PASS (7 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/gateway/src/glossary/term-scoring.ts packages/gateway/src/glossary/term-scoring.test.ts
git commit -m "feat(glossary): candidate scoring with service-spread weighting"
```

---

### Task 6: Synonyms and near-misses

**Files:**
- Create: `packages/gateway/src/glossary/near-miss.ts`
- Test: `packages/gateway/src/glossary/near-miss.test.ts`

**Interfaces:**
- Consumes: `normalizeTerm` (Task 3).
- Produces:
  - `detectAcronymExpansions(text: string): Array<{ acronymKey: string; expansion: string }>` — recognizes the `Change Data Record (CDR)` pattern.
  - `findNearMisses(termKey: string, knownKeys: readonly string[], limit?: number): string[]` — other keys within edit distance ≤ 2, never the term itself.

- [ ] **Step 1: Write the failing test**

Create `packages/gateway/src/glossary/near-miss.test.ts`:

```typescript
import { expect, test } from "bun:test";

import { detectAcronymExpansions, findNearMisses } from "./near-miss.ts";

test("detects an expansion followed by a parenthesized acronym", () => {
  const found = detectAcronymExpansions("we adopted Change Data Record (CDR) last year");
  expect(found).toEqual([{ acronymKey: "cdr", expansion: "Change Data Record" }]);
});

test("ignores a parenthesized acronym whose initials do not match", () => {
  expect(detectAcronymExpansions("Some Other Words (XYZ) here")).toEqual([]);
});

test("returns an empty array when there is no pattern", () => {
  expect(detectAcronymExpansions("nothing to see")).toEqual([]);
});

test("finds keys within edit distance two", () => {
  expect(findNearMisses("cdr", ["cdc", "sre", "cdrs"])).toContain("cdc");
});

test("never returns the term itself", () => {
  expect(findNearMisses("cdr", ["cdr", "cdc"])).not.toContain("cdr");
});

test("excludes keys beyond edit distance two", () => {
  expect(findNearMisses("cdr", ["deployment"])).toEqual([]);
});

test("respects the limit", () => {
  const out = findNearMisses("cdr", ["cdc", "cdx", "cdq", "cds"], 2);
  expect(out.length).toBe(2);
});

test("handles an empty known list", () => {
  expect(findNearMisses("cdr", [])).toEqual([]);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun test packages/gateway/src/glossary/near-miss.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the module**

Create `packages/gateway/src/glossary/near-miss.ts`:

```typescript
import { normalizeTerm } from "./term-normalize.ts";

/**
 * Deterministic synonym + near-miss derivation.
 *
 * Synonyms come from the `Expansion (ACRONYM)` pattern that teams write
 * naturally in docs and tickets — no LLM needed, and the result is verifiable
 * against the source text.
 */

const EXPANSION_RE = /\b((?:[A-Z][A-Za-z0-9]*\s+){1,5})\(([A-Z]{2,6})\)/g;

const MAX_EDIT_DISTANCE = 2;
const DEFAULT_NEAR_MISS_LIMIT = 5;

function initials(phrase: string): string {
  return phrase
    .trim()
    .split(/\s+/)
    .map((w) => w[0] ?? "")
    .join("")
    .toLowerCase();
}

export function detectAcronymExpansions(
  text: string,
): Array<{ acronymKey: string; expansion: string }> {
  const out: Array<{ acronymKey: string; expansion: string }> = [];
  EXPANSION_RE.lastIndex = 0;
  let m: RegExpExecArray | null = EXPANSION_RE.exec(text);
  while (m !== null) {
    const phrase = (m[1] ?? "").trim();
    const acronym = m[2] ?? "";
    if (phrase !== "" && acronym !== "" && initials(phrase) === acronym.toLowerCase()) {
      out.push({ acronymKey: normalizeTerm(acronym), expansion: phrase });
    }
    m = EXPANSION_RE.exec(text);
  }
  return out;
}

/** Bounded Levenshtein — returns `MAX_EDIT_DISTANCE + 1` once the budget is blown. */
function editDistance(a: string, b: string): number {
  if (Math.abs(a.length - b.length) > MAX_EDIT_DISTANCE) return MAX_EDIT_DISTANCE + 1;
  let prev: number[] = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const row: number[] = [i];
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      row.push(Math.min((row[j - 1] ?? 0) + 1, (prev[j] ?? 0) + 1, (prev[j - 1] ?? 0) + cost));
    }
    prev = row;
  }
  return prev[b.length] ?? MAX_EDIT_DISTANCE + 1;
}

export function findNearMisses(
  termKey: string,
  knownKeys: readonly string[],
  limit: number = DEFAULT_NEAR_MISS_LIMIT,
): string[] {
  const out: string[] = [];
  for (const k of knownKeys) {
    if (k === termKey) continue;
    if (editDistance(termKey, k) <= MAX_EDIT_DISTANCE) out.push(k);
    if (out.length >= limit) break;
  }
  return out;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `bun test packages/gateway/src/glossary/near-miss.test.ts`
Expected: PASS (8 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/gateway/src/glossary/near-miss.ts packages/gateway/src/glossary/near-miss.test.ts
git commit -m "feat(glossary): acronym-expansion synonyms and edit-distance near-misses"
```

---

### Task 7: Source scope + FTS statistics recompute + V45 store

**Files:**
- Create: `packages/gateway/src/glossary/glossary-source-types.ts`
- Create: `packages/gateway/src/glossary/glossary-store.ts`
- Test: `packages/gateway/src/glossary/glossary-store.test.ts`

**Interfaces:**
- Consumes: `dbRun` from `../db/write.ts`; `GlossaryTerm`, `TermStats`, `GlossarySource`, `CandidateForm`, `GlossaryStatus`, `DefinitionSource` (Task 4).
- Produces: `GLOSSARY_SOURCE_TYPES`, `glossarySourceTypeList()`, `computeTermStats(db, termKey): TermStats`, `upsertCandidate(db, c)`, `getTerm(db, key): GlossaryTerm | null`, `findBySynonym(db, q): GlossaryTerm | null`, `selectPendingBatch(db, limit, { nowMs, retryBaseCooldownMs })`, `recordAttempt(db, key, nowMs)`, `retryCooldownMs(attempts, baseMs)`, `selectStaleForRecheck(db, limit, verifiedBefore)`, `listConsolidated(db, limit)`, `listAllKeys(db)`, `markConsolidated(db, p)`, `markVetoed(db, key, nowMs)`, `demoteTerm(db, key, nowMs)`, `applyStats(db, key, stats, score, nowMs)`, `countByStatus(db)`, `readPassState(db)`, `writePassState(db, s)`, `clearGlossary(db)`.

- [ ] **Step 1: Write the source-scope module**

Create `packages/gateway/src/glossary/glossary-source-types.ts`:

```typescript
/**
 * Which indexed item types feed glossary mining.
 *
 * Email and calendar are deliberately absent. The roadmap does not list them,
 * and mining a personal inbox into a TEAM glossary is not a posture to adopt
 * silently. Keys are `service:type`, matching PROSE_HEAVY_TYPES style.
 *
 * `filesystem:git_commit` is the ONLY confirmed commit source
 * (`connectors/filesystem-v2-sync.ts`). That row stores the commit subject in
 * `title` and the SHA in `body_preview`, so mining reads it from the title —
 * which is why the scan concatenates title and body rather than reading the
 * body alone.
 *
 * No generic markdown item type exists, so ADRs are mined only when their
 * repository is indexed as an Obsidian vault (`obsidian:obsidian_note`).
 * Recorded in the spec's Known Limits rather than silently under-delivered.
 */
export const GLOSSARY_SOURCE_TYPES: ReadonlySet<string> = new Set([
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
  "github:commit",
  "gitlab:commit",
  "filesystem:git_commit",
]);

/** The bare `type` values, for the SQL `type IN (...)` filter. */
export function glossarySourceTypeList(): string[] {
  const types = new Set<string>();
  for (const key of GLOSSARY_SOURCE_TYPES) {
    const idx = key.indexOf(":");
    types.add(idx === -1 ? key : key.slice(idx + 1));
  }
  return [...types];
}
```

- [ ] **Step 2: Write the failing store test**

Create `packages/gateway/src/glossary/glossary-store.test.ts`:

```typescript
import { Database } from "bun:sqlite";
import { beforeEach, expect, test } from "bun:test";

import { CURRENT_SCHEMA_VERSION } from "../index/local-index.ts";
import { runIndexedSchemaMigrations } from "../index/migrations/runner.ts";

/** There is no `runMigrations` export — this wrapper matches every other test in the repo. */
function runMigrations(db: Database): void {
  runIndexedSchemaMigrations(db, CURRENT_SCHEMA_VERSION);
}
import { upsertIndexedItem } from "../index/item-store.ts";
import {
  applyStats, clearGlossary, computeTermStats, countByStatus, demoteTerm,
  findBySynonym, getTerm, listAllKeys, listConsolidated, markConsolidated,
  markVetoed, readPassState, recordAttempt, retryCooldownMs, selectPendingBatch,
  selectStaleForRecheck, upsertCandidate, writePassState,
} from "./glossary-store.ts";

let db: Database;

function seedItem(o: { externalId: string; service?: string; title: string; body: string; modifiedAt: number }): void {
  upsertIndexedItem(db, {
    service: o.service ?? "slack",
    type: "message",
    externalId: o.externalId,
    title: o.title,
    bodyPreview: o.body,
    modifiedAt: o.modifiedAt,
    syncedAt: o.modifiedAt,
  });
}

function seedCandidate(key: string, score = 1): void {
  upsertCandidate(db, {
    key,
    surface: key.toUpperCase(),
    form: "acronym",
    stats: { docFreq: 3, serviceSpread: 1, firstSeenAt: 100, lastSeenAt: 200, topSources: [] },
    score,
    nowMs: 1000,
  });
}

function consolidate(key: string, nowMs = 2000, synonyms: string[] = []): void {
  markConsolidated(db, {
    termKey: key, definition: "d", definitionSource: "llm",
    synonyms, nearMisses: [], nowMs,
  });
}

beforeEach(() => {
  db = new Database(":memory:");
  runMigrations(db);
});

test("computeTermStats counts distinct citing items and services", () => {
  seedItem({ externalId: "a", title: "CDR rollout", body: "the CDR is live", modifiedAt: 100 });
  seedItem({ externalId: "b", title: "more CDR", body: "CDR again", modifiedAt: 300 });
  seedItem({ externalId: "c", service: "jira", title: "CDR ticket", body: "CDR work", modifiedAt: 200 });
  const s = computeTermStats(db, "cdr");
  expect(s.docFreq).toBe(3);
  expect(s.serviceSpread).toBe(2);
  expect(s.firstSeenAt).toBe(100);
  expect(s.lastSeenAt).toBe(300);
});

test("computeTermStats returns at most five top sources", () => {
  for (let i = 0; i < 8; i++) {
    seedItem({ externalId: `i${String(i)}`, title: "CDR", body: "CDR here", modifiedAt: 100 + i });
  }
  expect(computeTermStats(db, "cdr").topSources.length).toBe(5);
});

test("computeTermStats is zero for an absent term", () => {
  expect(computeTermStats(db, "nosuchterm").docFreq).toBe(0);
});

test("computeTermStats ignores item types outside the source scope", () => {
  upsertIndexedItem(db, {
    service: "gmail", type: "email", externalId: "e1",
    title: "CDR in mail", bodyPreview: "CDR private",
    modifiedAt: 100, syncedAt: 100,
  });
  expect(computeTermStats(db, "cdr").docFreq).toBe(0);
});

test("computeTermStats drops to zero after the citing item is deleted", () => {
  seedItem({ externalId: "a", title: "CDR", body: "CDR", modifiedAt: 100 });
  expect(computeTermStats(db, "cdr").docFreq).toBe(1);
  db.run("DELETE FROM item");
  expect(computeTermStats(db, "cdr").docFreq).toBe(0);
});

test("upsertCandidate inserts pending and getTerm round-trips it", () => {
  seedCandidate("cdr");
  const t = getTerm(db, "cdr");
  expect(t?.status).toBe("pending");
  expect(t?.displayTerm).toBe("CDR");
  expect(t?.docFreq).toBe(3);
});

test("upsertCandidate never downgrades a consolidated row", () => {
  seedCandidate("cdr");
  consolidate("cdr");
  seedCandidate("cdr");
  expect(getTerm(db, "cdr")?.status).toBe("consolidated");
});

test("a hyphenated term is matched (documented phrase-equivalence)", () => {
  seedItem({ externalId: "h1", title: "caching", body: "we use write-behind caching", modifiedAt: 100 });
  seedItem({ externalId: "h2", title: "caching", body: "write-behind again", modifiedAt: 101 });
  expect(computeTermStats(db, "write-behind").docFreq).toBe(2);
});

test("hyphenated matching is phrase-equivalent — unhyphenated prose also counts", () => {
  // Asserts ACTUAL FTS5 unicode61 behaviour, not an ideal: `-` is a token
  // separator, so this is a phrase search for `write behind`. Documented in
  // `ftsQuery`. If this ever starts failing, the tokenizer changed.
  seedItem({ externalId: "h1", title: "caching", body: "we use write-behind caching", modifiedAt: 100 });
  seedItem({ externalId: "h2", title: "prose", body: "we write behind the scenes", modifiedAt: 101 });
  expect(computeTermStats(db, "write-behind").docFreq).toBe(2);
});

test("an underscored term is matched", () => {
  seedItem({ externalId: "u1", title: "keys", body: "set the shard_key first", modifiedAt: 100 });
  expect(computeTermStats(db, "shard_key").docFreq).toBe(1);
});

test("a term key with FTS-hostile characters degrades to zero, never throws", () => {
  expect(() => computeTermStats(db, 'we"ird^(term)')).not.toThrow();
});

const QUEUE = { nowMs: 10_000, retryBaseCooldownMs: 1000 };

test("markVetoed is sticky and keeps the row out of the pending batch", () => {
  seedCandidate("cdr");
  markVetoed(db, "cdr", 2000);
  expect(getTerm(db, "cdr")?.status).toBe("vetoed");
  expect(selectPendingBatch(db, 10, QUEUE).length).toBe(0);
});

test("selectPendingBatch orders by score descending and honours the limit", () => {
  seedCandidate("low", 1);
  seedCandidate("high", 9);
  seedCandidate("mid", 5);
  expect(selectPendingBatch(db, 2, QUEUE).map((t) => t.termKey)).toEqual(["high", "mid"]);
});

test("a freshly-attempted term is withheld while its backoff is active", () => {
  seedCandidate("high", 9);
  seedCandidate("low", 1);
  recordAttempt(db, "high", 10_000);
  const batch = selectPendingBatch(db, 10, { nowMs: 10_500, retryBaseCooldownMs: 1000 });
  expect(batch.map((t) => t.termKey)).toEqual(["low"]);
});

test("a term returns to the queue once its backoff expires", () => {
  seedCandidate("high", 9);
  recordAttempt(db, "high", 10_000);
  const batch = selectPendingBatch(db, 10, { nowMs: 12_000, retryBaseCooldownMs: 1000 });
  expect(batch.map((t) => t.termKey)).toEqual(["high"]);
});

test("backoff grows with repeated failures", () => {
  seedCandidate("high", 9);
  recordAttempt(db, "high", 0);
  recordAttempt(db, "high", 0);
  recordAttempt(db, "high", 0);
  // attempts=3 -> base * 2^2 = 4000 ms
  expect(selectPendingBatch(db, 10, { nowMs: 3000, retryBaseCooldownMs: 1000 }).length).toBe(0);
  expect(selectPendingBatch(db, 10, { nowMs: 5000, retryBaseCooldownMs: 1000 }).length).toBe(1);
});

test("retryCooldownMs caps at 24 hours", () => {
  expect(retryCooldownMs(50, 1000)).toBe(24 * 60 * 60 * 1000);
  expect(retryCooldownMs(0, 1000)).toBe(0);
});

test("selectStaleForRecheck returns consolidated rows oldest-verified first", () => {
  seedCandidate("a");
  seedCandidate("b");
  consolidate("a", 5000);
  consolidate("b", 5000);
  applyStats(db, "b", { docFreq: 3, serviceSpread: 1, firstSeenAt: 1, lastSeenAt: 2, topSources: [] }, 1, 9000);
  expect(selectStaleForRecheck(db, 1, 20_000)[0]?.termKey).toBe("a");
});

test("selectStaleForRecheck skips terms verified after the cutoff", () => {
  seedCandidate("a");
  consolidate("a", 5000);
  expect(selectStaleForRecheck(db, 10, 4000).length).toBe(0);
  expect(selectStaleForRecheck(db, 10, 6000).length).toBe(1);
});

test("findBySynonym resolves the canonical term", () => {
  seedCandidate("cdr");
  consolidate("cdr", 2000, ["change data record"]);
  expect(findBySynonym(db, "change data record")?.termKey).toBe("cdr");
  expect(findBySynonym(db, "nope")).toBe(null);
});

test("demoteTerm returns a consolidated row to pending and clears its definition", () => {
  seedCandidate("cdr");
  consolidate("cdr");
  demoteTerm(db, "cdr", 3000);
  const t = getTerm(db, "cdr");
  expect(t?.status).toBe("pending");
  expect(t?.definition).toBe(null);
});

test("countByStatus reports totals", () => {
  seedCandidate("a");
  seedCandidate("b");
  consolidate("a");
  markVetoed(db, "b", 2000);
  const c = countByStatus(db);
  expect(c.total).toBe(1);
  expect(c.vetoed).toBe(1);
});

test("listConsolidated is ranked by score", () => {
  seedCandidate("low", 1);
  seedCandidate("high", 9);
  consolidate("low");
  consolidate("high");
  expect(listConsolidated(db, 10)[0]?.termKey).toBe("high");
});

test("pass state defaults to a zero watermark and round-trips", () => {
  expect(readPassState(db).watermarkMs).toBe(0);
  writePassState(db, { watermarkMs: 42, lastPassAt: 99, lastPassNew: 2, scannedItems: 7 });
  expect(readPassState(db).watermarkMs).toBe(42);
  writePassState(db, { watermarkMs: 50, lastPassAt: 100, lastPassNew: 1, scannedItems: 8 });
  expect(readPassState(db).watermarkMs).toBe(50);
});

test("listAllKeys and clearGlossary", () => {
  seedCandidate("a");
  seedCandidate("b");
  expect(listAllKeys(db).sort()).toEqual(["a", "b"]);
  clearGlossary(db);
  expect(listAllKeys(db)).toEqual([]);
  expect(readPassState(db).watermarkMs).toBe(0);
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `bun test packages/gateway/src/glossary/glossary-store.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 4: Implement the store**

Create `packages/gateway/src/glossary/glossary-store.ts`. Every write uses `dbRun` (**I14**); every value is bound (**I9**):

```typescript
import type { Database } from "bun:sqlite";

import { dbRun } from "../db/write.ts";
import { glossarySourceTypeList } from "./glossary-source-types.ts";
import type {
  CandidateForm, DefinitionSource, GlossarySource, GlossaryStatus,
  GlossaryTerm, TermStats,
} from "./glossary-types.ts";

const TOP_SOURCE_LIMIT = 5;

type Row = {
  term_key: string; display_term: string; status: string;
  definition: string | null; definition_source: string | null;
  doc_freq: number; service_spread: number; score: number; form: string;
  first_seen_at: number; last_seen_at: number; top_sources: string;
  synonyms: string; near_misses: string; consolidated_at: number | null;
  stats_verified_at: number; updated_at: number;
};

function parseJsonArray<T>(raw: string): T[] {
  try {
    const v: unknown = JSON.parse(raw);
    return Array.isArray(v) ? (v as T[]) : [];
  } catch {
    return [];
  }
}

function toTerm(r: Row): GlossaryTerm {
  return {
    termKey: r.term_key,
    displayTerm: r.display_term,
    status: r.status as GlossaryStatus,
    definition: r.definition,
    definitionSource: r.definition_source as DefinitionSource | null,
    docFreq: r.doc_freq,
    serviceSpread: r.service_spread,
    score: r.score,
    form: r.form as CandidateForm,
    firstSeenAt: r.first_seen_at,
    lastSeenAt: r.last_seen_at,
    topSources: parseJsonArray<GlossarySource>(r.top_sources),
    synonyms: parseJsonArray<string>(r.synonyms),
    nearMisses: parseJsonArray<string>(r.near_misses),
    consolidatedAt: r.consolidated_at,
    statsVerifiedAt: r.stats_verified_at,
    updatedAt: r.updated_at,
  };
}

/**
 * FTS MATCH needs the key quoted so a multi-word term is a phrase, not an AND.
 *
 * KNOWN LIMIT — the default unicode61 tokenizer treats `-` and `_` as
 * separators, so `"write-behind"` is really the PHRASE `write behind` and also
 * matches unhyphenated prose ("we write behind the scenes"). Measured, not
 * assumed: that query returns 2 rows against a 3-row corpus. Hyphenated and
 * underscored terms can therefore over-count slightly, and in the worst case a
 * non-term clears `min_doc_freq` on adjacent-word coincidences.
 *
 * Accepted rather than fixed: the alternative is re-scanning candidate bodies
 * for the exact surface form, which trades the whole point of using the FTS
 * index for a small accuracy gain on two of five families. The test suite
 * asserts the ACTUAL behaviour so nobody "fixes" it into a false ideal.
 */
function ftsQuery(termKey: string): string {
  return `"${termKey.replace(/"/g, '""')}"`;
}

/**
 * FTS5 raises on malformed query syntax, and term keys derive from arbitrary
 * indexed content. One bad key must not abort a whole extraction pass, so a
 * failed match degrades to "no evidence" — the term simply falls below the
 * frequency floor and is skipped.
 */
function safeFtsGet<T>(run: () => T, fallback: T): T {
  try {
    return run();
  } catch {
    return fallback;
  }
}

function typePlaceholders(): { sql: string; params: string[] } {
  const types = glossarySourceTypeList();
  return { sql: types.map(() => "?").join(", "), params: types };
}

/**
 * The spec-§5.1 recompute. Statistics are ALWAYS derived from the live FTS
 * index — never accumulated — so the result is idempotent under re-runs,
 * edits and deletions.
 */
export function computeTermStats(db: Database, termKey: string): TermStats {
  const { sql: ph, params: types } = typePlaceholders();
  const agg = safeFtsGet(
    () =>
      db
        .query(
          `SELECT COUNT(*) AS doc_freq,
                  COUNT(DISTINCT i.service) AS service_spread,
                  MIN(i.modified_at) AS first_seen,
                  MAX(i.modified_at) AS last_seen
           FROM item_fts f
           JOIN item i ON i.rowid = f.rowid
           WHERE item_fts MATCH ? AND i.type IN (${ph})`,
        )
        .get(ftsQuery(termKey), ...types) as {
        doc_freq: number; service_spread: number;
        first_seen: number | null; last_seen: number | null;
      } | null,
    null,
  );

  if (agg === null || agg.doc_freq === 0) {
    return { docFreq: 0, serviceSpread: 0, firstSeenAt: 0, lastSeenAt: 0, topSources: [] };
  }

  const sources = db
    .query(
      `SELECT i.id, i.title, i.url, i.service, i.modified_at
       FROM item_fts f
       JOIN item i ON i.rowid = f.rowid
       WHERE item_fts MATCH ? AND i.type IN (${ph})
       ORDER BY i.modified_at DESC
       LIMIT ?`,
    )
    .all(ftsQuery(termKey), ...types, TOP_SOURCE_LIMIT) as Array<{
    id: string; title: string; url: string | null; service: string; modified_at: number;
  }>;

  return {
    docFreq: agg.doc_freq,
    serviceSpread: agg.service_spread,
    firstSeenAt: agg.first_seen ?? 0,
    lastSeenAt: agg.last_seen ?? 0,
    topSources: sources.map((s) => ({
      itemId: s.id, title: s.title, url: s.url,
      service: s.service, modifiedAt: s.modified_at,
    })),
  };
}

export function upsertCandidate(
  db: Database,
  c: { key: string; surface: string; form: CandidateForm; stats: TermStats; score: number; nowMs: number },
): void {
  // ON CONFLICT deliberately leaves `status` untouched: a consolidated or
  // vetoed row must never be silently returned to the pending queue by a
  // later sighting of the same term.
  dbRun(
    db,
    `INSERT INTO glossary_term (
       term_key, display_term, status, doc_freq, service_spread, score, form,
       first_seen_at, last_seen_at, top_sources, updated_at
     ) VALUES (?, ?, 'pending', ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(term_key) DO UPDATE SET
       display_term = excluded.display_term, doc_freq = excluded.doc_freq,
       service_spread = excluded.service_spread, score = excluded.score,
       form = excluded.form, first_seen_at = excluded.first_seen_at,
       last_seen_at = excluded.last_seen_at, top_sources = excluded.top_sources,
       updated_at = excluded.updated_at`,
    [
      c.key, c.surface, c.stats.docFreq, c.stats.serviceSpread, c.score, c.form,
      c.stats.firstSeenAt, c.stats.lastSeenAt, JSON.stringify(c.stats.topSources), c.nowMs,
    ],
  );
}

export function getTerm(db: Database, termKey: string): GlossaryTerm | null {
  const r = db.query("SELECT * FROM glossary_term WHERE term_key = ?").get(termKey) as Row | null;
  return r === null ? null : toTerm(r);
}

export function findBySynonym(db: Database, normalizedQuery: string): GlossaryTerm | null {
  const rows = db
    .query("SELECT * FROM glossary_term WHERE status = 'consolidated' AND synonyms <> '[]'")
    .all() as Row[];
  const needle = normalizedQuery.toLowerCase();
  for (const r of rows) {
    if (parseJsonArray<string>(r.synonyms).some((s) => s.toLowerCase() === needle)) return toTerm(r);
  }
  return null;
}

/** Exponential backoff, capped at 24 h, so a permanently-failing term steps aside. */
export function retryCooldownMs(attempts: number, baseMs: number): number {
  if (attempts <= 0) return 0;
  const DAY_MS = 24 * 60 * 60 * 1000;
  return Math.min(DAY_MS, baseMs * 2 ** (attempts - 1));
}

export function selectPendingBatch(
  db: Database,
  limit: number,
  opts: { nowMs: number; retryBaseCooldownMs: number },
): GlossaryTerm[] {
  // Selects across the WHOLE table, not just this pass's discoveries: a
  // high-scoring candidate deferred by the cap three passes ago must still
  // reach consolidation.
  //
  // The backoff filter is what stops head-of-line blocking. Ordering is by
  // score, and a failed consolidation stays `pending`, so without this the
  // top-scoring failures would monopolise every batch forever. Some failures
  // never succeed (snippet mode with no full-sentence mention), so this is
  // starvation by construction rather than a rare race.
  const rows = db
    .query(
      `SELECT * FROM glossary_term
       WHERE status = 'pending'
         AND (
           attempts = 0
           OR last_attempt_at + MIN(86400000, ? * (1 << (attempts - 1))) <= ?
         )
       ORDER BY score DESC
       LIMIT ?`,
    )
    .all(opts.retryBaseCooldownMs, opts.nowMs, limit) as Row[];
  return rows.map(toTerm);
}

/** Records a failed consolidation so the backoff above takes effect. */
export function recordAttempt(db: Database, termKey: string, nowMs: number): void {
  dbRun(
    db,
    `UPDATE glossary_term
     SET attempts = attempts + 1, last_attempt_at = ?, updated_at = ?
     WHERE term_key = ?`,
    [nowMs, nowMs, termKey],
  );
}

/**
 * Terms due for re-verification.
 *
 * `verifiedBefore` keeps the sweep from re-checking a term that was verified
 * minutes ago: the pass fires after every connector sync, and re-running ~100
 * FTS queries each time buys nothing when the last check is fresh. With a
 * 12 h cooldown the sweep is a no-op on most passes and still reaches full
 * coverage daily.
 */
export function selectStaleForRecheck(
  db: Database,
  limit: number,
  verifiedBefore: number,
): GlossaryTerm[] {
  const rows = db
    .query(
      `SELECT * FROM glossary_term
       WHERE status = 'consolidated' AND stats_verified_at < ?
       ORDER BY stats_verified_at ASC LIMIT ?`,
    )
    .all(verifiedBefore, limit) as Row[];
  return rows.map(toTerm);
}

export function listConsolidated(db: Database, limit: number): GlossaryTerm[] {
  const rows = db
    .query("SELECT * FROM glossary_term WHERE status = 'consolidated' ORDER BY score DESC LIMIT ?")
    .all(limit) as Row[];
  return rows.map(toTerm);
}

export function listAllKeys(db: Database): string[] {
  const rows = db.query("SELECT term_key FROM glossary_term").all() as Array<{ term_key: string }>;
  return rows.map((r) => r.term_key);
}

export function markConsolidated(
  db: Database,
  p: {
    termKey: string; definition: string; definitionSource: DefinitionSource;
    synonyms: string[]; nearMisses: string[]; nowMs: number;
  },
): void {
  dbRun(
    db,
    `UPDATE glossary_term
     SET status = 'consolidated', definition = ?, definition_source = ?,
         synonyms = ?, near_misses = ?, consolidated_at = ?,
         stats_verified_at = ?, updated_at = ?
     WHERE term_key = ?`,
    [
      p.definition, p.definitionSource, JSON.stringify(p.synonyms),
      JSON.stringify(p.nearMisses), p.nowMs, p.nowMs, p.nowMs, p.termKey,
    ],
  );
}

export function markVetoed(db: Database, termKey: string, nowMs: number): void {
  dbRun(db, "UPDATE glossary_term SET status = 'vetoed', updated_at = ? WHERE term_key = ?", [
    nowMs, termKey,
  ]);
}

export function demoteTerm(db: Database, termKey: string, nowMs: number): void {
  dbRun(
    db,
    `UPDATE glossary_term
     SET status = 'pending', definition = NULL, definition_source = NULL,
         consolidated_at = NULL, updated_at = ?
     WHERE term_key = ?`,
    [nowMs, termKey],
  );
}

export function applyStats(
  db: Database, termKey: string, stats: TermStats, score: number, nowMs: number,
): void {
  dbRun(
    db,
    `UPDATE glossary_term
     SET doc_freq = ?, service_spread = ?, score = ?, first_seen_at = ?,
         last_seen_at = ?, top_sources = ?, stats_verified_at = ?, updated_at = ?
     WHERE term_key = ?`,
    [
      stats.docFreq, stats.serviceSpread, score, stats.firstSeenAt, stats.lastSeenAt,
      JSON.stringify(stats.topSources), nowMs, nowMs, termKey,
    ],
  );
}

export function countByStatus(db: Database): { total: number; pending: number; vetoed: number } {
  const r = db
    .query(
      `SELECT
         SUM(CASE WHEN status = 'consolidated' THEN 1 ELSE 0 END) AS total,
         SUM(CASE WHEN status = 'pending'      THEN 1 ELSE 0 END) AS pending,
         SUM(CASE WHEN status = 'vetoed'       THEN 1 ELSE 0 END) AS vetoed
       FROM glossary_term`,
    )
    .get() as { total: number | null; pending: number | null; vetoed: number | null } | null;
  return { total: r?.total ?? 0, pending: r?.pending ?? 0, vetoed: r?.vetoed ?? 0 };
}

export type GlossaryPassState = {
  watermarkMs: number;
  lastPassAt: number | null;
  lastPassNew: number;
  scannedItems: number;
};

export function readPassState(db: Database): GlossaryPassState {
  const r = db.query("SELECT * FROM glossary_pass_state WHERE id = 1").get() as {
    watermark_ms: number; last_pass_at: number | null;
    last_pass_new: number; scanned_items: number;
  } | null;
  if (r === null) return { watermarkMs: 0, lastPassAt: null, lastPassNew: 0, scannedItems: 0 };
  return {
    watermarkMs: r.watermark_ms,
    lastPassAt: r.last_pass_at,
    lastPassNew: r.last_pass_new,
    scannedItems: r.scanned_items,
  };
}

export function writePassState(db: Database, s: GlossaryPassState): void {
  dbRun(
    db,
    `INSERT INTO glossary_pass_state (id, watermark_ms, last_pass_at, last_pass_new, scanned_items)
     VALUES (1, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       watermark_ms = excluded.watermark_ms, last_pass_at = excluded.last_pass_at,
       last_pass_new = excluded.last_pass_new, scanned_items = excluded.scanned_items`,
    [s.watermarkMs, s.lastPassAt, s.lastPassNew, s.scannedItems],
  );
}

export function clearGlossary(db: Database): void {
  dbRun(db, "DELETE FROM glossary_term", []);
  dbRun(db, "DELETE FROM glossary_pass_state", []);
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `bun test packages/gateway/src/glossary/glossary-store.test.ts`
Expected: PASS (26 tests).

If `computeTermStats` returns 0 for a multi-word key, check `ftsQuery` — an unquoted multi-word MATCH is an implicit AND, not a phrase.

- [ ] **Step 6: Verify the I14 static check**

Run: `bun run audit:invariants`
Expected: PASS. If it flags `glossary-store.ts`, a raw `db.run(...)` slipped in — route it through `dbRun`.

- [ ] **Step 7: Commit**

```bash
git add packages/gateway/src/glossary/glossary-source-types.ts packages/gateway/src/glossary/glossary-store.ts packages/gateway/src/glossary/glossary-store.test.ts
git commit -m "feat(glossary): V45 store plus the FTS statistics recompute"
```

---

### Task 8: Item projection (and the 512-char trap)

**Files:**
- Create: `packages/gateway/src/glossary/glossary-project.ts`
- Modify: `packages/gateway/src/embedding/routing.ts`
- Modify: `packages/gateway/src/embedding/routing.test.ts`
- Test: `packages/gateway/src/glossary/glossary-project.test.ts`

**Interfaces:**
- Consumes: `upsertIndexedItem`, `itemPrimaryKey` from `../index/item-store.ts`; `dbRun`; `GlossaryTerm` (Task 4).
- Produces: `projectTerm(db, term, nowMs): string`, `unprojectTerm(db, termKey): void`, `glossaryItemExternalId(termKey): string`, `buildProjectedBody(definition, synonyms): string`.

- [ ] **Step 1: Write the failing test**

Create `packages/gateway/src/glossary/glossary-project.test.ts`:

```typescript
import { Database } from "bun:sqlite";
import { beforeEach, expect, test } from "bun:test";

import { CURRENT_SCHEMA_VERSION } from "../index/local-index.ts";
import { runIndexedSchemaMigrations } from "../index/migrations/runner.ts";

/** There is no `runMigrations` export — this wrapper matches every other test in the repo. */
function runMigrations(db: Database): void {
  runIndexedSchemaMigrations(db, CURRENT_SCHEMA_VERSION);
}
import { buildProjectedBody, projectTerm, unprojectTerm } from "./glossary-project.ts";
import type { GlossaryTerm } from "./glossary-types.ts";

let db: Database;

function term(over: Partial<GlossaryTerm> = {}): GlossaryTerm {
  return {
    termKey: "cdr",
    displayTerm: "CDR",
    status: "consolidated",
    definition: "Change Data Record — the per-row change envelope.",
    definitionSource: "llm",
    docFreq: 7,
    serviceSpread: 2,
    score: 3.2,
    form: "acronym",
    firstSeenAt: 100,
    lastSeenAt: 900,
    topSources: [],
    synonyms: ["Change Data Record"],
    nearMisses: [],
    consolidatedAt: 1000,
    statsVerifiedAt: 1000,
    updatedAt: 1000,
    ...over,
  };
}

beforeEach(() => {
  db = new Database(":memory:");
  runMigrations(db);
});

test("projects a consolidated term as a nimbus:glossary_term item", () => {
  projectTerm(db, term(), 1000);
  const row = db.query("SELECT * FROM item WHERE type = 'glossary_term'").get() as
    | { service: string; title: string; body_preview: string } | null;
  expect(row?.service).toBe("nimbus");
  expect(row?.title).toBe("CDR");
  expect(row?.body_preview).toContain("Change Data Record");
});

test("synonyms land in body_preview so FTS can reach them", () => {
  projectTerm(db, term(), 1000);
  const hit = db
    .query("SELECT COUNT(*) AS c FROM item_fts WHERE item_fts MATCH ?")
    .get('"change data record"') as { c: number };
  expect(hit.c).toBeGreaterThan(0);
});

test("buildProjectedBody keeps synonyms even when the definition is long", () => {
  const body = buildProjectedBody("x".repeat(900), ["Change Data Record"]);
  expect(body.length).toBeLessThanOrEqual(512);
  expect(body).toContain("Change Data Record");
});

test("buildProjectedBody omits the synonym line when there are none", () => {
  expect(buildProjectedBody("short def", [])).toBe("short def");
});

test("projection is idempotent — re-projecting updates in place", () => {
  projectTerm(db, term(), 1000);
  projectTerm(db, term({ definition: "updated definition" }), 2000);
  expect(db.query("SELECT * FROM item WHERE type = 'glossary_term'").all().length).toBe(1);
});

test("unprojectTerm removes the item row", () => {
  projectTerm(db, term(), 1000);
  unprojectTerm(db, "cdr");
  expect(db.query("SELECT * FROM item WHERE type = 'glossary_term'").all().length).toBe(0);
});

test("unprojectTerm is safe when nothing is projected", () => {
  expect(() => unprojectTerm(db, "absent")).not.toThrow();
});

test("a term with no definition is not projected", () => {
  expect(() => projectTerm(db, term({ definition: null }), 1000)).toThrow();
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun test packages/gateway/src/glossary/glossary-project.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement projection**

Create `packages/gateway/src/glossary/glossary-project.ts`:

```typescript
import type { Database } from "bun:sqlite";

import { dbRun } from "../db/write.ts";
import { itemPrimaryKey, upsertIndexedItem } from "../index/item-store.ts";
import type { GlossaryTerm } from "./glossary-types.ts";

const SERVICE = "nimbus";
const TYPE = "glossary_term";

/** `upsertIndexedItem` clips body_preview at 512 chars — mirror that budget here. */
const BODY_LIMIT = 512;
const SYNONYM_PREFIX = "Also known as: ";

export function glossaryItemExternalId(termKey: string): string {
  return `glossary:${termKey}`;
}

/**
 * Builds the indexed body.
 *
 * `item_fts` indexes only `title` and `body_preview` — metadata JSON is
 * invisible to both FTS and the embedding pipeline. Synonyms therefore have to
 * live in the body text, or `ask "what does Change Data Record mean?"` finds
 * nothing while the acronym query succeeds — exactly backwards, since the
 * person who needs the glossary is the one who does not know the acronym yet.
 *
 * The synonym line is reserved FIRST and the definition truncated into what is
 * left, because `upsertIndexedItem` clips at 512 chars and a naive append would
 * be silently cut away.
 */
export function buildProjectedBody(definition: string, synonyms: readonly string[]): string {
  if (synonyms.length === 0) return definition.slice(0, BODY_LIMIT);

  const synLine = `${SYNONYM_PREFIX}${synonyms.join(", ")}`.slice(0, BODY_LIMIT);
  const room = BODY_LIMIT - synLine.length - 2; // 2 = the "\n\n" separator
  if (room <= 0) return synLine;
  return `${definition.slice(0, room)}\n\n${synLine}`;
}

export function projectTerm(db: Database, term: GlossaryTerm, nowMs: number): string {
  if (term.definition === null) {
    throw new Error(`cannot project glossary term "${term.termKey}" without a definition`);
  }
  const externalId = glossaryItemExternalId(term.termKey);
  upsertIndexedItem(db, {
    service: SERVICE,
    type: TYPE,
    externalId,
    title: term.displayTerm,
    bodyPreview: buildProjectedBody(term.definition, term.synonyms),
    url: null,
    canonicalUrl: null,
    modifiedAt: term.lastSeenAt,
    syncedAt: nowMs,
    metadata: {
      source: "glossary",
      definitions: [term.definition],
      definitionSource: term.definitionSource,
      synonyms: term.synonyms,
      nearMisses: term.nearMisses,
      topSources: term.topSources,
      firstSeenAt: term.firstSeenAt,
      lastSeenAt: term.lastSeenAt,
      docFreq: term.docFreq,
      generatedAt: nowMs,
    },
  });
  return itemPrimaryKey(SERVICE, externalId);
}

/**
 * Removes a term from the searchable index. Called when a term is demoted or
 * vetoed: a stale definition surfacing in search after the term was rejected
 * would be worse than no glossary at all.
 */
export function unprojectTerm(db: Database, termKey: string): void {
  dbRun(db, "DELETE FROM item WHERE id = ?", [
    itemPrimaryKey(SERVICE, glossaryItemExternalId(termKey)),
  ]);
}
```

- [ ] **Step 4: Add the embedding-routing entry**

In `packages/gateway/src/embedding/routing.ts`, append inside `PROSE_HEAVY_TYPES`, after the `nimbus:research_brief` entry:

```typescript
  // Consolidated glossary definitions are prose synthesis, like
  // nimbus:research_brief. MiniLM-only fallback when openai.api_key is absent.
  "nimbus:glossary_term",
```

In `packages/gateway/src/embedding/routing.test.ts`, add `"nimbus:glossary_term"` to the `expected` set and rename the test from `(22 entries)` to `(23 entries)`.

- [ ] **Step 5: Run the tests**

Run: `bun test packages/gateway/src/glossary/glossary-project.test.ts packages/gateway/src/embedding/routing.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/gateway/src/glossary/glossary-project.ts packages/gateway/src/glossary/glossary-project.test.ts packages/gateway/src/embedding/routing.ts packages/gateway/src/embedding/routing.test.ts
git commit -m "feat(glossary): project consolidated terms into the searchable index"
```

---

### Task 9: Consolidation (LLM, veto, timeout, snippet fallback)

**Files:**
- Create: `packages/gateway/src/glossary/glossary-consolidate.ts`
- Test: `packages/gateway/src/glossary/glossary-consolidate.test.ts`

**Interfaces:**
- Consumes: `wrapToolOutput` from `../engine/tool-output-envelope.ts`; `GlossaryTerm`, `GlossarySource` (Task 4); `detectAcronymExpansions` (Task 6).
- Produces:
  - `type ConsolidatorLlm = { generateJson: (prompt: string) => Promise<string | null> }`
  - `type ConsolidationOutcome = { kind: "defined"; definition: string; source: DefinitionSource; synonyms: string[] } | { kind: "vetoed" } | { kind: "retry"; reason: string }`
  - `consolidateTerm(term: GlossaryTerm, snippets: readonly { text: string }[], opts: { llm?: ConsolidatorLlm; timeoutMs: number }): Promise<ConsolidationOutcome>`
  - `pickSnippetDefinition(displayTerm: string, snippets: readonly { text: string }[]): string | null`

The LLM is injected, never imported — this keeps the module testable without `mock.module` and lets the extract orchestrator decide whether a model exists at all.

- [ ] **Step 1: Write the failing test**

Create `packages/gateway/src/glossary/glossary-consolidate.test.ts`:

```typescript
import { expect, test } from "bun:test";

import { consolidateTerm, pickSnippetDefinition } from "./glossary-consolidate.ts";
import type { GlossaryTerm } from "./glossary-types.ts";

function term(over: Partial<GlossaryTerm> = {}): GlossaryTerm {
  return {
    termKey: "cdr", displayTerm: "CDR", status: "pending",
    definition: null, definitionSource: null, docFreq: 5, serviceSpread: 2,
    score: 3, form: "acronym", firstSeenAt: 1, lastSeenAt: 2, topSources: [],
    synonyms: [], nearMisses: [], consolidatedAt: null, statsVerifiedAt: 0,
    updatedAt: 0, ...over,
  };
}

const SNIPPETS = [{ text: "We adopted Change Data Record (CDR) for the sync path." }];

test("happy path returns an llm-sourced definition", async () => {
  const llm = {
    generateJson: async () =>
      JSON.stringify({ isDomainTerm: true, definition: "The per-row change envelope." }),
  };
  const out = await consolidateTerm(term(), SNIPPETS, { llm, timeoutMs: 1000 });
  expect(out.kind).toBe("defined");
  if (out.kind === "defined") {
    expect(out.source).toBe("llm");
    expect(out.definition).toBe("The per-row change envelope.");
  }
});

test("isDomainTerm false yields a veto", async () => {
  const llm = { generateJson: async () => JSON.stringify({ isDomainTerm: false, definition: "" }) };
  const out = await consolidateTerm(term(), SNIPPETS, { llm, timeoutMs: 1000 });
  expect(out.kind).toBe("vetoed");
});

test("alsoKnownAs merges with detected acronym expansions", async () => {
  const llm = {
    generateJson: async () =>
      JSON.stringify({ isDomainTerm: true, definition: "d", alsoKnownAs: ["CDR event"] }),
  };
  const out = await consolidateTerm(term(), SNIPPETS, { llm, timeoutMs: 1000 });
  if (out.kind !== "defined") throw new Error("expected defined");
  expect(out.synonyms).toContain("CDR event");
  expect(out.synonyms).toContain("Change Data Record");
});

test("malformed JSON yields retry, never a veto", async () => {
  const llm = { generateJson: async () => "not json at all" };
  const out = await consolidateTerm(term(), SNIPPETS, { llm, timeoutMs: 1000 });
  expect(out.kind).toBe("retry");
});

test("empty response yields retry", async () => {
  const llm = { generateJson: async () => "" };
  expect((await consolidateTerm(term(), SNIPPETS, { llm, timeoutMs: 1000 })).kind).toBe("retry");
});

test("a null response yields retry", async () => {
  const llm = { generateJson: async () => null };
  expect((await consolidateTerm(term(), SNIPPETS, { llm, timeoutMs: 1000 })).kind).toBe("retry");
});

test("a thrown LLM error yields retry, never a veto", async () => {
  const llm = {
    generateJson: async () => {
      throw new Error("model unavailable");
    },
  };
  expect((await consolidateTerm(term(), SNIPPETS, { llm, timeoutMs: 1000 })).kind).toBe("retry");
});

test("a hung LLM times out into retry", async () => {
  const llm = { generateJson: () => new Promise<string>(() => undefined) };
  const out = await consolidateTerm(term(), SNIPPETS, { llm, timeoutMs: 20 });
  expect(out.kind).toBe("retry");
});

test("an abort settles a hung call without waiting for the timeout", async () => {
  const llm = { generateJson: () => new Promise<string>(() => undefined) };
  const controller = new AbortController();
  setTimeout(() => controller.abort(), 10);

  const started = Date.now();
  const out = await consolidateTerm(term(), SNIPPETS, {
    llm,
    timeoutMs: 30_000,
    signal: controller.signal,
  });

  expect(out.kind).toBe("retry");
  expect(Date.now() - started).toBeLessThan(1000);
});

test("an already-aborted signal returns immediately", async () => {
  const llm = { generateJson: () => new Promise<string>(() => undefined) };
  const controller = new AbortController();
  controller.abort();
  const out = await consolidateTerm(term(), SNIPPETS, {
    llm,
    timeoutMs: 30_000,
    signal: controller.signal,
  });
  expect(out.kind).toBe("retry");
});

test("the signal is forwarded to the provider", async () => {
  let seen: AbortSignal | undefined;
  const controller = new AbortController();
  const llm = {
    generateJson: async (_p: string, signal?: AbortSignal) => {
      seen = signal;
      return JSON.stringify({ isDomainTerm: true, definition: "d" });
    },
  };
  await consolidateTerm(term(), SNIPPETS, { llm, timeoutMs: 1000, signal: controller.signal });
  expect(seen).toBe(controller.signal);
});

test("no LLM falls back to a verbatim snippet definition", async () => {
  const out = await consolidateTerm(term(), SNIPPETS, { timeoutMs: 1000 });
  expect(out.kind).toBe("defined");
  if (out.kind === "defined") {
    expect(out.source).toBe("snippet");
    expect(out.definition).toContain("Change Data Record");
  }
});

test("no LLM and no usable snippet yields retry", async () => {
  const out = await consolidateTerm(term(), [{ text: "unrelated prose" }], { timeoutMs: 1000 });
  expect(out.kind).toBe("retry");
});

test("pickSnippetDefinition returns the sentence containing the term", () => {
  const got = pickSnippetDefinition("CDR", [
    { text: "Nothing here. The CDR is the change envelope. Trailing text." },
  ]);
  expect(got).toBe("The CDR is the change envelope.");
});

test("pickSnippetDefinition returns null when the term is absent", () => {
  expect(pickSnippetDefinition("CDR", [{ text: "no mention" }])).toBe(null);
});

test("the prompt wraps source snippets in a tool-output envelope", async () => {
  let seen = "";
  const llm = {
    generateJson: async (p: string) => {
      seen = p;
      return JSON.stringify({ isDomainTerm: true, definition: "d" });
    },
  };
  await consolidateTerm(term(), SNIPPETS, { llm, timeoutMs: 1000 });
  expect(seen).toContain("<tool_output");
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun test packages/gateway/src/glossary/glossary-consolidate.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement consolidation**

Create `packages/gateway/src/glossary/glossary-consolidate.ts`:

```typescript
import { wrapToolOutput } from "../engine/tool-output-envelope.ts";
import type { DefinitionSource, GlossaryTerm } from "./glossary-types.ts";
import { detectAcronymExpansions } from "./near-miss.ts";

/**
 * Injected so the module is testable without `mock.module` (CI-Linux leaks it).
 *
 * The optional `signal` lets a provider cancel the underlying request on
 * shutdown. It is optional so existing fakes and simple providers stay valid.
 */
export type ConsolidatorLlm = {
  generateJson: (prompt: string, signal?: AbortSignal) => Promise<string | null>;
};

export type ConsolidationOutcome =
  | { kind: "defined"; definition: string; source: DefinitionSource; synonyms: string[] }
  | { kind: "vetoed" }
  | { kind: "retry"; reason: string };

const DEFINITION_MAX = 400;

const INSTRUCTIONS = [
  "You are consolidating how one engineering team actually uses a term.",
  "Given the term and quoted source snippets, respond with JSON only:",
  '{"isDomainTerm": boolean, "definition": string, "alsoKnownAs": string[]}',
  "Rules:",
  "- isDomainTerm is false for generic English, generic technology, or code syntax.",
  "- The definition must come from the snippets. Never invent facts not present in them.",
  "- Keep the definition under two sentences.",
  "- Output JSON only — no prose, no code fences.",
].join("\n");

/** Splits on sentence boundaries; keeps the terminator. */
function sentences(text: string): string[] {
  return text
    .split(/(?<=[.!?])\s+/)
    .map((s) => s.trim())
    .filter((s) => s !== "");
}

/**
 * The no-LLM definition: the first sentence that actually mentions the term.
 * Honest and attributable — a raw quote rather than a synthesis, which the
 * brief labels as such.
 */
export function pickSnippetDefinition(
  displayTerm: string,
  snippets: readonly { text: string }[],
): string | null {
  const needle = displayTerm.toLowerCase();
  for (const s of snippets) {
    for (const sentence of sentences(s.text)) {
      if (sentence.toLowerCase().includes(needle)) return sentence.slice(0, DEFINITION_MAX);
    }
  }
  return null;
}

type ParsedResponse = { isDomainTerm: boolean; definition: string; alsoKnownAs: string[] };

function parseResponse(raw: string): ParsedResponse | null {
  let v: unknown;
  try {
    v = JSON.parse(raw);
  } catch {
    return null;
  }
  if (v === null || typeof v !== "object") return null;
  const o = v as { isDomainTerm?: unknown; definition?: unknown; alsoKnownAs?: unknown };
  if (typeof o.isDomainTerm !== "boolean") return null;
  const definition = typeof o.definition === "string" ? o.definition : "";
  const alsoKnownAs = Array.isArray(o.alsoKnownAs)
    ? o.alsoKnownAs.filter((x): x is string => typeof x === "string")
    : [];
  return { isDomainTerm: o.isDomainTerm, definition, alsoKnownAs };
}

/**
 * Bounds the wait on a model call by BOTH a timeout and an abort.
 *
 * Without the abort arm, a 30 s timeout means shutdown waits up to 30 s per
 * in-flight term. We can only stop WAITING — if the provider ignores its
 * signal the request may keep running in the background — but that is what
 * makes shutdown responsive.
 */
async function withTimeout(
  p: Promise<string | null>,
  ms: number,
  signal?: AbortSignal,
): Promise<string | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let onAbort: (() => void) | undefined;
  try {
    return await Promise.race([
      p,
      new Promise<null>((resolve) => {
        timer = setTimeout(() => resolve(null), ms);
      }),
      new Promise<null>((resolve) => {
        if (signal === undefined) return;
        if (signal.aborted) {
          resolve(null);
          return;
        }
        onAbort = () => resolve(null);
        signal.addEventListener("abort", onAbort, { once: true });
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    if (onAbort !== undefined) signal?.removeEventListener("abort", onAbort);
  }
}

/**
 * Consolidates one term.
 *
 * A `retry` outcome is deliberately distinct from `vetoed`: an unparseable,
 * empty, timed-out or thrown response is an INFRASTRUCTURE failure and must
 * never be recorded as a judgment about the term. Only an explicit
 * `isDomainTerm: false` vetoes.
 */
export async function consolidateTerm(
  term: GlossaryTerm,
  snippets: readonly { text: string }[],
  opts: { llm?: ConsolidatorLlm; timeoutMs: number; signal?: AbortSignal },
): Promise<ConsolidationOutcome> {
  const detected = detectAcronymExpansions(snippets.map((s) => s.text).join("\n"))
    .filter((e) => e.acronymKey === term.termKey)
    .map((e) => e.expansion);

  if (opts.llm === undefined) {
    const snippet = pickSnippetDefinition(term.displayTerm, snippets);
    if (snippet === null) return { kind: "retry", reason: "no snippet mentions the term" };
    return { kind: "defined", definition: snippet, source: "snippet", synonyms: detected };
  }

  // I11: indexed third-party content reaching the model must be enveloped.
  const wrapped = wrapToolOutput(
    { service: "nimbus", tool: "glossary.consolidate" },
    { term: term.displayTerm, snippets: snippets.map((s) => s.text) },
  );
  const prompt = `${INSTRUCTIONS}\n\nTerm: ${term.displayTerm}\n\nSources:\n${wrapped}`;

  let raw: string | null;
  try {
    raw = await withTimeout(
      opts.llm.generateJson(prompt, opts.signal),
      opts.timeoutMs,
      opts.signal,
    );
  } catch (err) {
    return { kind: "retry", reason: err instanceof Error ? err.message : String(err) };
  }
  if (raw === null || raw.trim() === "") return { kind: "retry", reason: "empty response" };

  const parsed = parseResponse(raw);
  if (parsed === null) return { kind: "retry", reason: "unparseable response" };
  if (!parsed.isDomainTerm) return { kind: "vetoed" };
  if (parsed.definition.trim() === "") return { kind: "retry", reason: "empty definition" };

  const synonyms = [...new Set([...parsed.alsoKnownAs, ...detected])];
  return {
    kind: "defined",
    definition: parsed.definition.slice(0, DEFINITION_MAX),
    source: "llm",
    synonyms,
  };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `bun test packages/gateway/src/glossary/glossary-consolidate.test.ts`
Expected: PASS (17 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/gateway/src/glossary/glossary-consolidate.ts packages/gateway/src/glossary/glossary-consolidate.test.ts
git commit -m "feat(glossary): LLM consolidation with veto, timeout and snippet fallback"
```

---

### Task 10: Reconciliation sweep

**Files:**
- Create: `packages/gateway/src/glossary/glossary-reconcile.ts`
- Test: `packages/gateway/src/glossary/glossary-reconcile.test.ts`

**Interfaces:**
- Consumes: `selectStaleForRecheck`, `computeTermStats`, `applyStats`, `demoteTerm` (Task 7); `unprojectTerm` (Task 8); `scoreTerm` (Task 5).
- Produces: `reconcilePass(db, opts: { limit: number; minDocFreq: number; nowMs: number }): { verified: number; demoted: string[] }`.

This closes the spec-§5.1 gap: a term whose sources were deleted is never re-discovered by the incremental scan, because deletion bumps no `modified_at`.

- [ ] **Step 1: Write the failing test**

Create `packages/gateway/src/glossary/glossary-reconcile.test.ts`:

```typescript
import { Database } from "bun:sqlite";
import { beforeEach, expect, test } from "bun:test";

import { CURRENT_SCHEMA_VERSION } from "../index/local-index.ts";
import { runIndexedSchemaMigrations } from "../index/migrations/runner.ts";

/** There is no `runMigrations` export — this wrapper matches every other test in the repo. */
function runMigrations(db: Database): void {
  runIndexedSchemaMigrations(db, CURRENT_SCHEMA_VERSION);
}
import { upsertIndexedItem } from "../index/item-store.ts";
import { projectTerm } from "./glossary-project.ts";
import { reconcilePass } from "./glossary-reconcile.ts";
import { getTerm, markConsolidated, upsertCandidate } from "./glossary-store.ts";

let db: Database;

function seedItem(externalId: string, body: string, modifiedAt: number): void {
  upsertIndexedItem(db, {
    service: "slack", type: "message", externalId,
    title: body, bodyPreview: body, modifiedAt, syncedAt: modifiedAt,
  });
}

function seedConsolidated(key: string, docFreq: number, nowMs = 1000): void {
  upsertCandidate(db, {
    key, surface: key.toUpperCase(), form: "acronym",
    stats: { docFreq, serviceSpread: 1, firstSeenAt: 1, lastSeenAt: 2, topSources: [] },
    score: 5, nowMs,
  });
  markConsolidated(db, {
    termKey: key, definition: "a definition", definitionSource: "llm",
    synonyms: [], nearMisses: [], nowMs,
  });
  const t = getTerm(db, key);
  if (t !== null) projectTerm(db, t, nowMs);
}

beforeEach(() => {
  db = new Database(":memory:");
  runMigrations(db);
});

test("a term whose sources vanished is demoted and unprojected", () => {
  seedItem("a", "CDR one", 100);
  seedItem("b", "CDR two", 100);
  seedItem("c", "CDR three", 100);
  seedConsolidated("cdr", 3);
  db.run("DELETE FROM item WHERE type = 'message'");

  const out = reconcilePass(db, { limit: 10, minDocFreq: 3, nowMs: 2000, cooldownMs: 0 });

  expect(out.demoted).toEqual(["cdr"]);
  expect(getTerm(db, "cdr")?.status).toBe("pending");
  expect(db.query("SELECT * FROM item WHERE type = 'glossary_term'").all().length).toBe(0);
});

test("a term still above the floor keeps its definition and is re-stamped", () => {
  seedItem("a", "CDR one", 100);
  seedItem("b", "CDR two", 100);
  seedItem("c", "CDR three", 100);
  seedConsolidated("cdr", 3);

  const out = reconcilePass(db, { limit: 10, minDocFreq: 3, nowMs: 2000, cooldownMs: 0 });

  expect(out.demoted).toEqual([]);
  const t = getTerm(db, "cdr");
  expect(t?.status).toBe("consolidated");
  expect(t?.definition).toBe("a definition");
  expect(t?.statsVerifiedAt).toBe(2000);
});

test("statistics are refreshed rather than left stale", () => {
  seedItem("a", "CDR one", 100);
  seedItem("b", "CDR two", 100);
  seedItem("c", "CDR three", 100);
  seedConsolidated("cdr", 99);
  reconcilePass(db, { limit: 10, minDocFreq: 3, nowMs: 2000, cooldownMs: 0 });
  expect(getTerm(db, "cdr")?.docFreq).toBe(3);
});

test("the sweep honours its limit", () => {
  seedItem("a", "CDR one AAA BBB", 100);
  seedConsolidated("cdr", 3, 1000);
  seedConsolidated("aaa", 3, 1000);
  seedConsolidated("bbb", 3, 1000);
  expect(reconcilePass(db, { limit: 2, minDocFreq: 3, nowMs: 2000, cooldownMs: 0 }).verified).toBe(2);
});

test("the sweep is a no-op on an empty glossary", () => {
  const out = reconcilePass(db, { limit: 10, minDocFreq: 3, nowMs: 2000, cooldownMs: 0 });
  expect(out).toEqual({ verified: 0, demoted: [] });
});

test("round-robin reaches a different term on the next pass", () => {
  seedItem("a", "CDR one AAA", 100);
  seedConsolidated("cdr", 3, 1000);
  seedConsolidated("aaa", 3, 1000);
  reconcilePass(db, { limit: 1, minDocFreq: 3, nowMs: 2000, cooldownMs: 0 });
  reconcilePass(db, { limit: 1, minDocFreq: 3, nowMs: 3000, cooldownMs: 0 });
  expect(getTerm(db, "cdr")?.statsVerifiedAt).toBeGreaterThan(1000);
  expect(getTerm(db, "aaa")?.statsVerifiedAt).toBeGreaterThan(1000);
});

test("the cooldown makes a repeat sweep a no-op", () => {
  seedItem("a", "CDR one", 100);
  seedItem("b", "CDR two", 100);
  seedItem("c", "CDR three", 100);
  seedConsolidated("cdr", 3, 1000);

  const first = reconcilePass(db, { limit: 10, minDocFreq: 3, nowMs: 100_000, cooldownMs: 1000 });
  expect(first.verified).toBe(1);

  // Immediately after: the term was just verified, so nothing is due.
  const second = reconcilePass(db, { limit: 10, minDocFreq: 3, nowMs: 100_500, cooldownMs: 1000 });
  expect(second.verified).toBe(0);

  // Once the cooldown lapses it becomes due again.
  const third = reconcilePass(db, { limit: 10, minDocFreq: 3, nowMs: 102_000, cooldownMs: 1000 });
  expect(third.verified).toBe(1);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun test packages/gateway/src/glossary/glossary-reconcile.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the sweep**

Create `packages/gateway/src/glossary/glossary-reconcile.ts`:

```typescript
import type { Database } from "bun:sqlite";

import { unprojectTerm } from "./glossary-project.ts";
import {
  applyStats,
  computeTermStats,
  demoteTerm,
  selectStaleForRecheck,
} from "./glossary-store.ts";
import { scoreTerm } from "./term-scoring.ts";

export type ReconcileSummary = { verified: number; demoted: string[] };

/**
 * Re-verifies the least-recently-checked consolidated terms, round-robin.
 *
 * Necessary because the incremental scan can never revisit a term whose
 * sources were deleted: deletion bumps no `modified_at`, and an edit that
 * removes the last mention leaves no item to re-discover the term from. The
 * FTS index is correct throughout — only the trigger to re-read it is missing.
 *
 * Pure SQL, zero LLM cost, so it runs on every pass unconditionally.
 */
export function reconcilePass(
  db: Database,
  opts: { limit: number; minDocFreq: number; nowMs: number; cooldownMs: number },
): ReconcileSummary {
  // The cooldown is what keeps this cheap. The pass fires after EVERY
  // successful connector sync, and each verified term costs 2 FTS queries —
  // re-checking 50 terms every minute would be ~100 FTS queries a minute for
  // no new information. With a 12 h cooldown the sweep is a no-op on most
  // passes and still reaches full coverage daily.
  const stale = selectStaleForRecheck(db, opts.limit, opts.nowMs - opts.cooldownMs);
  const demoted: string[] = [];

  for (const term of stale) {
    const stats = computeTermStats(db, term.termKey);
    if (stats.docFreq < opts.minDocFreq) {
      // Below the floor: the evidence is gone. Drop it from the searchable
      // index first — a stale definition surfacing in search after its
      // sources vanished is worse than no glossary at all.
      unprojectTerm(db, term.termKey);
      demoteTerm(db, term.termKey, opts.nowMs);
      applyStats(db, term.termKey, stats, 0, opts.nowMs);
      demoted.push(term.termKey);
      continue;
    }
    // Still a term — only its evidence moved. No LLM call.
    const score = scoreTerm({
      docFreq: stats.docFreq,
      serviceSpread: stats.serviceSpread,
      form: term.form,
    });
    applyStats(db, term.termKey, stats, score, opts.nowMs);
  }

  return { verified: stale.length, demoted };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `bun test packages/gateway/src/glossary/glossary-reconcile.test.ts`
Expected: PASS (7 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/gateway/src/glossary/glossary-reconcile.ts packages/gateway/src/glossary/glossary-reconcile.test.ts
git commit -m "feat(glossary): reconciliation sweep for deleted and edited sources"
```

---

### Task 11: The two-phase pass orchestrator

**Files:**
- Create: `packages/gateway/src/glossary/glossary-extract.ts`
- Test: `packages/gateway/src/glossary/glossary-extract.test.ts`
- Test: `packages/gateway/src/glossary/glossary-resume.test.ts`

**Interfaces:**
- Consumes: everything from Tasks 2–10.
- Produces:
  - `type GlossaryPassOptions = { maxNewTermsPerPass: number; statsRecheckPerPass: number; minDocFreq: number; consolidateTimeoutMs: number; llm?: ConsolidatorLlm; nowMs: number; signal?: AbortSignal }`
  - `type GlossaryPassSummary = { scanned: number; discovered: number; consolidated: number; vetoed: number; retried: number; demoted: number; aborted: boolean }`
  - `runGlossaryPass(db, opts): Promise<GlossaryPassSummary>`
  - `rebuildGlossary(db, opts): Promise<GlossaryPassSummary>`

- [ ] **Step 1: Write the failing pass test**

Create `packages/gateway/src/glossary/glossary-extract.test.ts`:

```typescript
import { Database } from "bun:sqlite";
import { beforeEach, expect, test } from "bun:test";

import { CURRENT_SCHEMA_VERSION } from "../index/local-index.ts";
import { runIndexedSchemaMigrations } from "../index/migrations/runner.ts";

/** There is no `runMigrations` export — this wrapper matches every other test in the repo. */
function runMigrations(db: Database): void {
  runIndexedSchemaMigrations(db, CURRENT_SCHEMA_VERSION);
}
import { upsertIndexedItem } from "../index/item-store.ts";
import type { ConsolidatorLlm } from "./glossary-consolidate.ts";
import { rebuildGlossary, runGlossaryPass } from "./glossary-extract.ts";
import { getTerm, listAllKeys, readPassState } from "./glossary-store.ts";

let db: Database;

const OPTS = {
  maxNewTermsPerPass: 25,
  statsRecheckPerPass: 50,
  statsRecheckCooldownMs: 0,
  minDocFreq: 3,
  consolidateTimeoutMs: 1000,
  retryBaseCooldownMs: 1000,
  nowMs: 5000,
};

function definingLlm(): ConsolidatorLlm {
  return {
    generateJson: async () => JSON.stringify({ isDomainTerm: true, definition: "a definition" }),
  };
}

function seedTermItems(count: number, text: string, startId = 0): void {
  for (let i = 0; i < count; i++) {
    upsertIndexedItem(db, {
      service: "slack", type: "message", externalId: `m${String(startId + i)}`,
      title: text, bodyPreview: text,
      modifiedAt: 1000 + startId + i, syncedAt: 1000 + startId + i,
    });
  }
}

beforeEach(() => {
  db = new Database(":memory:");
  runMigrations(db);
});

test("discovers, consolidates and projects a qualifying term", async () => {
  seedTermItems(3, "the CDR pipeline runs nightly");
  const out = await runGlossaryPass(db, { ...OPTS, llm: definingLlm() });

  expect(out.discovered).toBeGreaterThan(0);
  expect(getTerm(db, "cdr")?.status).toBe("consolidated");
  const items = db.query("SELECT * FROM item WHERE type = 'glossary_term'").all();
  expect(items.length).toBeGreaterThan(0);
});

test("a term below the frequency floor is never stored", async () => {
  seedTermItems(2, "the CDR pipeline runs nightly");
  await runGlossaryPass(db, { ...OPTS, llm: definingLlm() });
  expect(getTerm(db, "cdr")).toBe(null);
});

test("running the pass twice converges on identical statistics", async () => {
  seedTermItems(4, "the CDR pipeline runs nightly");
  await runGlossaryPass(db, { ...OPTS, llm: definingLlm() });
  const first = getTerm(db, "cdr");
  await runGlossaryPass(db, { ...OPTS, llm: definingLlm(), nowMs: 6000 });
  const second = getTerm(db, "cdr");

  expect(second?.docFreq).toBe(first?.docFreq ?? -1);
  expect(second?.serviceSpread).toBe(first?.serviceSpread ?? -1);
  expect(second?.firstSeenAt).toBe(first?.firstSeenAt ?? -1);
});

test("the second pass makes zero LLM calls when nothing changed", async () => {
  seedTermItems(4, "the CDR pipeline runs nightly");
  await runGlossaryPass(db, { ...OPTS, llm: definingLlm() });

  let calls = 0;
  const counting: ConsolidatorLlm = {
    generateJson: async () => {
      calls += 1;
      return JSON.stringify({ isDomainTerm: true, definition: "d" });
    },
  };
  await runGlossaryPass(db, { ...OPTS, llm: counting, nowMs: 6000 });
  expect(calls).toBe(0);
});

test("the per-pass consolidation cap is honoured", async () => {
  seedTermItems(3, "CDR and SLO and RPO and MTTR and SLA metrics", 0);
  const out = await runGlossaryPass(db, { ...OPTS, maxNewTermsPerPass: 2, llm: definingLlm() });
  expect(out.consolidated).toBeLessThanOrEqual(2);
});

test("a vetoed term is stored vetoed and never projected", async () => {
  seedTermItems(3, "the CDR pipeline runs nightly");
  const vetoing: ConsolidatorLlm = {
    generateJson: async () => JSON.stringify({ isDomainTerm: false, definition: "" }),
  };
  await runGlossaryPass(db, { ...OPTS, llm: vetoing });

  expect(getTerm(db, "cdr")?.status).toBe("vetoed");
  expect(db.query("SELECT * FROM item WHERE type = 'glossary_term'").all().length).toBe(0);
});

test("with no LLM the definition is snippet-sourced", async () => {
  seedTermItems(3, "The CDR is the per-row change envelope.");
  await runGlossaryPass(db, OPTS);
  const t = getTerm(db, "cdr");
  expect(t?.status).toBe("consolidated");
  expect(t?.definitionSource).toBe("snippet");
});

test("the watermark advances past the scanned items", async () => {
  seedTermItems(3, "the CDR pipeline runs nightly");
  await runGlossaryPass(db, { ...OPTS, llm: definingLlm() });
  expect(readPassState(db).watermarkMs).toBeGreaterThan(0);
});

test("a second pass scans only new items", async () => {
  seedTermItems(3, "the CDR pipeline runs nightly", 0);
  await runGlossaryPass(db, { ...OPTS, llm: definingLlm() });
  const out = await runGlossaryPass(db, { ...OPTS, llm: definingLlm(), nowMs: 6000 });
  expect(out.scanned).toBe(0);
});

test("an empty index yields an empty summary", async () => {
  const out = await runGlossaryPass(db, { ...OPTS, llm: definingLlm() });
  expect(out.discovered).toBe(0);
  expect(out.consolidated).toBe(0);
});

test("rebuildGlossary clears rows, projections and the watermark", async () => {
  seedTermItems(3, "the CDR pipeline runs nightly");
  await runGlossaryPass(db, { ...OPTS, llm: definingLlm() });
  expect(listAllKeys(db).length).toBeGreaterThan(0);

  await rebuildGlossary(db, { ...OPTS, llm: definingLlm(), nowMs: 7000 });
  expect(getTerm(db, "cdr")?.status).toBe("consolidated");
  expect(readPassState(db).watermarkMs).toBeGreaterThan(0);
});
```

- [ ] **Step 2: Write the failing resume test**

Create `packages/gateway/src/glossary/glossary-resume.test.ts`:

```typescript
import { Database } from "bun:sqlite";
import { beforeEach, expect, test } from "bun:test";

import { CURRENT_SCHEMA_VERSION } from "../index/local-index.ts";
import { runIndexedSchemaMigrations } from "../index/migrations/runner.ts";

/** There is no `runMigrations` export — this wrapper matches every other test in the repo. */
function runMigrations(db: Database): void {
  runIndexedSchemaMigrations(db, CURRENT_SCHEMA_VERSION);
}
import { upsertIndexedItem } from "../index/item-store.ts";
import type { ConsolidatorLlm } from "./glossary-consolidate.ts";
import { runGlossaryPass } from "./glossary-extract.ts";
import { getTerm, readPassState, selectPendingBatch } from "./glossary-store.ts";

let db: Database;

const BASE = {
  maxNewTermsPerPass: 25,
  statsRecheckPerPass: 50,
  statsRecheckCooldownMs: 0,
  minDocFreq: 3,
  consolidateTimeoutMs: 1000,
  retryBaseCooldownMs: 1000,
  nowMs: 5000,
};

/** Far-future `nowMs` so assertions see every pending row regardless of backoff. */
const QUEUE = { nowMs: 9_000_000, retryBaseCooldownMs: 1000 };

function seed(text: string, count = 3, startId = 0): void {
  for (let i = 0; i < count; i++) {
    upsertIndexedItem(db, {
      service: "slack", type: "message", externalId: `m${String(startId + i)}`,
      title: text, bodyPreview: text,
      modifiedAt: 1000 + startId + i, syncedAt: 1000 + startId + i,
    });
  }
}

beforeEach(() => {
  db = new Database(":memory:");
  runMigrations(db);
});

test("aborting phase B holds the watermark and leaves candidates pending", async () => {
  seed("CDR and SLO and RPO metrics");
  const controller = new AbortController();
  const llm: ConsolidatorLlm = {
    generateJson: async () => {
      controller.abort();
      return JSON.stringify({ isDomainTerm: true, definition: "d" });
    },
  };

  const out = await runGlossaryPass(db, { ...BASE, llm, signal: controller.signal });

  expect(out.aborted).toBe(true);
  // Phase A committed before any LLM call, so the scan is not repeated.
  expect(readPassState(db).watermarkMs).toBeGreaterThan(0);
  expect(selectPendingBatch(db, 10, QUEUE).length).toBeGreaterThan(0);
});

test("the next pass completes candidates stranded by an abort", async () => {
  seed("CDR and SLO and RPO metrics");
  const controller = new AbortController();
  const abortingLlm: ConsolidatorLlm = {
    generateJson: async () => {
      controller.abort();
      return JSON.stringify({ isDomainTerm: true, definition: "d" });
    },
  };
  await runGlossaryPass(db, { ...BASE, llm: abortingLlm, signal: controller.signal });

  const goodLlm: ConsolidatorLlm = {
    generateJson: async () => JSON.stringify({ isDomainTerm: true, definition: "later" }),
  };
  await runGlossaryPass(db, { ...BASE, llm: goodLlm, nowMs: 6000 });

  expect(selectPendingBatch(db, 10, QUEUE).length).toBe(0);
});

test("a candidate stranded by the cap is reached by a later pass", async () => {
  seed("CDR and SLO and RPO and MTTR metrics");
  const llm: ConsolidatorLlm = {
    generateJson: async () => JSON.stringify({ isDomainTerm: true, definition: "d" }),
  };
  await runGlossaryPass(db, { ...BASE, maxNewTermsPerPass: 1, llm });
  const afterFirst = selectPendingBatch(db, 10, QUEUE).length;
  expect(afterFirst).toBeGreaterThan(0);

  // No new items — the batch must still be selected globally, not from this
  // pass's (empty) discoveries.
  await runGlossaryPass(db, { ...BASE, maxNewTermsPerPass: 10, llm, nowMs: 6000 });
  expect(selectPendingBatch(db, 10, QUEUE).length).toBe(0);
});

test("a retry outcome leaves the term pending rather than vetoed", async () => {
  seed("the CDR pipeline runs nightly");
  const badLlm: ConsolidatorLlm = { generateJson: async () => "not json" };
  await runGlossaryPass(db, { ...BASE, llm: badLlm });
  expect(getTerm(db, "cdr")?.status).toBe("pending");
});

test("a persistently failing high-score term does not starve lower-score terms", async () => {
  // `zzz` is seeded far more often, so it outranks `cdr` and is selected
  // first — and it ALWAYS fails. Without the retry backoff it would occupy
  // the single consolidation slot on every pass forever and `cdr` would never
  // be defined. This is the head-of-line-blocking regression test.
  seed("ZZZ metric review", 8, 0);
  seed("the CDR pipeline runs nightly", 3, 100);

  const llm: ConsolidatorLlm = {
    generateJson: async (prompt: string) =>
      prompt.includes("ZZZ")
        ? "not json"
        : JSON.stringify({ isDomainTerm: true, definition: "defined" }),
  };

  await runGlossaryPass(db, { ...BASE, maxNewTermsPerPass: 1, llm, nowMs: 5000 });
  expect(getTerm(db, "zzz")?.status).toBe("pending");

  // Second pass, still inside zzz's backoff window: cdr must get the slot.
  await runGlossaryPass(db, { ...BASE, maxNewTermsPerPass: 1, llm, nowMs: 5500 });
  expect(getTerm(db, "cdr")?.status).toBe("consolidated");
});

test("a failed term records an attempt and is withheld while backing off", async () => {
  seed("the CDR pipeline runs nightly");
  const badLlm: ConsolidatorLlm = { generateJson: async () => "not json" };
  await runGlossaryPass(db, { ...BASE, llm: badLlm, nowMs: 5000 });

  const out = await runGlossaryPass(db, { ...BASE, llm: badLlm, nowMs: 5100 });
  expect(out.retried).toBe(0); // still cooling down — not re-attempted
});
```

- [ ] **Step 3: Run both tests to verify they fail**

Run: `bun test packages/gateway/src/glossary/glossary-extract.test.ts packages/gateway/src/glossary/glossary-resume.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 4: Implement the orchestrator**

Create `packages/gateway/src/glossary/glossary-extract.ts`:

```typescript
import type { Database } from "bun:sqlite";

import { type ConsolidatorLlm, consolidateTerm } from "./glossary-consolidate.ts";
import { projectTerm, unprojectTerm } from "./glossary-project.ts";
import { reconcilePass } from "./glossary-reconcile.ts";
import { glossarySourceTypeList } from "./glossary-source-types.ts";
import {
  clearGlossary,
  computeTermStats,
  getTerm,
  listAllKeys,
  markConsolidated,
  markVetoed,
  readPassState,
  recordAttempt,
  selectPendingBatch,
  upsertCandidate,
  writePassState,
} from "./glossary-store.ts";
import { findNearMisses } from "./near-miss.ts";
import { mineTerms } from "./term-mining.ts";
import { scoreTerm } from "./term-scoring.ts";

export type GlossaryPassOptions = {
  maxNewTermsPerPass: number;
  statsRecheckPerPass: number;
  /** Skip re-verifying terms checked more recently than this. */
  statsRecheckCooldownMs: number;
  minDocFreq: number;
  consolidateTimeoutMs: number;
  /** Base for the exponential retry backoff that prevents queue starvation. */
  retryBaseCooldownMs: number;
  llm?: ConsolidatorLlm;
  nowMs: number;
  signal?: AbortSignal;
};

export type GlossaryPassSummary = {
  scanned: number;
  discovered: number;
  consolidated: number;
  vetoed: number;
  retried: number;
  demoted: number;
  aborted: boolean;
};

const SCAN_BATCH_LIMIT = 5000;

type ScanRow = { id: string; title: string; body_preview: string | null; modified_at: number };

function scanDelta(db: Database, watermarkMs: number): ScanRow[] {
  const types = glossarySourceTypeList();
  const ph = types.map(() => "?").join(", ");
  return db
    .query(
      `SELECT id, title, body_preview, modified_at
       FROM item
       WHERE type IN (${ph}) AND modified_at > ?
       ORDER BY modified_at ASC
       LIMIT ?`,
    )
    .all(...types, watermarkMs, SCAN_BATCH_LIMIT) as ScanRow[];
}

/** Snippets handed to consolidation — the indexed text of a term's top sources. */
function snippetsFor(db: Database, itemIds: readonly string[]): Array<{ text: string }> {
  if (itemIds.length === 0) return [];
  const ph = itemIds.map(() => "?").join(", ");
  const rows = db
    .query(`SELECT title, body_preview FROM item WHERE id IN (${ph})`)
    .all(...itemIds) as Array<{ title: string; body_preview: string | null }>;
  return rows.map((r) => ({ text: `${r.title}. ${r.body_preview ?? ""}`.trim() }));
}

/**
 * Phase A — discover. Pure SQL, committed before any LLM call.
 *
 * The watermark advances HERE, not after consolidation: candidates are durable
 * `pending` rows the moment this returns, so an interrupted phase B costs at
 * most one in-flight call rather than a full re-scan.
 */
function discoverPhase(
  db: Database,
  opts: GlossaryPassOptions,
): { scanned: number; discovered: number; demoted: number } {
  const state = readPassState(db);
  const rows = scanDelta(db, state.watermarkMs);

  let discovered = 0;
  let maxModified = state.watermarkMs;

  const seen = new Map<string, { surface: string; form: ReturnType<typeof mineTerms>[number]["form"] }>();
  for (const row of rows) {
    if (row.modified_at > maxModified) maxModified = row.modified_at;
    const text = `${row.title}\n${row.body_preview ?? ""}`;
    for (const c of mineTerms(text)) {
      if (!seen.has(c.key)) seen.set(c.key, { surface: c.surface, form: c.form });
    }
  }

  for (const [key, c] of seen) {
    const stats = computeTermStats(db, key);
    if (stats.docFreq < opts.minDocFreq) continue;
    upsertCandidate(db, {
      key,
      surface: c.surface,
      form: c.form,
      stats,
      score: scoreTerm({ docFreq: stats.docFreq, serviceSpread: stats.serviceSpread, form: c.form }),
      nowMs: opts.nowMs,
    });
    discovered += 1;
  }

  const reconciled = reconcilePass(db, {
    limit: opts.statsRecheckPerPass,
    minDocFreq: opts.minDocFreq,
    nowMs: opts.nowMs,
    cooldownMs: opts.statsRecheckCooldownMs,
  });

  writePassState(db, {
    watermarkMs: maxModified,
    lastPassAt: opts.nowMs,
    lastPassNew: discovered,
    scannedItems: rows.length,
  });

  return { scanned: rows.length, discovered, demoted: reconciled.demoted.length };
}

/**
 * Phase B — consolidate. One transaction per term, sequential.
 *
 * Sequential is deliberate: parallel requests multiply resident model memory on
 * a local Ollama, and nothing user-facing waits on this pass (reads hit the
 * materialized table).
 */
async function consolidatePhase(
  db: Database,
  opts: GlossaryPassOptions,
): Promise<{ consolidated: number; vetoed: number; retried: number; aborted: boolean }> {
  const batch = selectPendingBatch(db, opts.maxNewTermsPerPass, {
    nowMs: opts.nowMs,
    retryBaseCooldownMs: opts.retryBaseCooldownMs,
  });
  const knownKeys = listAllKeys(db);

  let consolidated = 0;
  let vetoed = 0;
  let retried = 0;

  for (const term of batch) {
    if (opts.signal?.aborted === true) {
      return { consolidated, vetoed, retried, aborted: true };
    }

    const snippets = snippetsFor(db, term.topSources.map((s) => s.itemId));
    const outcome = await consolidateTerm(term, snippets, {
      ...(opts.llm === undefined ? {} : { llm: opts.llm }),
      timeoutMs: opts.consolidateTimeoutMs,
      ...(opts.signal === undefined ? {} : { signal: opts.signal }),
    });

    if (outcome.kind === "vetoed") {
      unprojectTerm(db, term.termKey);
      markVetoed(db, term.termKey, opts.nowMs);
      vetoed += 1;
      continue;
    }
    if (outcome.kind === "retry") {
      // Stamp the attempt so the backoff in `selectPendingBatch` lets
      // lower-scoring terms through on the next pass. Without this the
      // top-scoring failures would monopolise every batch forever.
      recordAttempt(db, term.termKey, opts.nowMs);
      retried += 1;
      continue;
    }

    markConsolidated(db, {
      termKey: term.termKey,
      definition: outcome.definition,
      definitionSource: outcome.source,
      synonyms: outcome.synonyms,
      nearMisses: findNearMisses(term.termKey, knownKeys),
      nowMs: opts.nowMs,
    });
    const stored = getTerm(db, term.termKey);
    if (stored !== null) projectTerm(db, stored, opts.nowMs);
    consolidated += 1;
  }

  return { consolidated, vetoed, retried, aborted: opts.signal?.aborted === true };
}

export async function runGlossaryPass(
  db: Database,
  opts: GlossaryPassOptions,
): Promise<GlossaryPassSummary> {
  const a = discoverPhase(db, opts);
  if (opts.signal?.aborted === true) {
    return { ...a, consolidated: 0, vetoed: 0, retried: 0, aborted: true };
  }
  const b = await consolidatePhase(db, opts);
  return { ...a, ...b };
}

/** Wipes every glossary row and projection, then re-mines from watermark zero. */
export async function rebuildGlossary(
  db: Database,
  opts: GlossaryPassOptions,
): Promise<GlossaryPassSummary> {
  for (const key of listAllKeys(db)) unprojectTerm(db, key);
  clearGlossary(db);
  return runGlossaryPass(db, opts);
}
```

- [ ] **Step 5: Run both tests to verify they pass**

Run: `bun test packages/gateway/src/glossary/`
Expected: PASS across every glossary test file.

- [ ] **Step 6: Commit**

```bash
git add packages/gateway/src/glossary/glossary-extract.ts packages/gateway/src/glossary/glossary-extract.test.ts packages/gateway/src/glossary/glossary-resume.test.ts
git commit -m "feat(glossary): two-phase extraction pass with crash-safe watermarking"
```

---

### Task 12: `[glossary]` config + debounced refresh trigger + scheduler wiring

**Files:**
- Modify: `packages/gateway/src/config/nimbus-toml.ts`
- Create: `packages/gateway/src/config/nimbus-toml-glossary.test.ts`
- Create: `packages/gateway/src/glossary/glossary-refresh.ts`
- Test: `packages/gateway/src/glossary/glossary-refresh.test.ts`
- Modify: `packages/gateway/src/platform/assemble.ts`

**Interfaces:**
- Consumes: `runGlossaryPass` (Task 11); `forEachSectionEntry`, `parseBool`, `parseIntDec` (existing, in `nimbus-toml.ts`).
- Produces:
  - `NimbusGlossaryToml`, `DEFAULT_NIMBUS_GLOSSARY_TOML`, `parseNimbusGlossaryToml(raw, defaults?)`
  - `createGlossaryRefresher(deps): { trigger: () => void; stop: () => void }`

- [ ] **Step 1: Write the failing config test**

Create `packages/gateway/src/config/nimbus-toml-glossary.test.ts`:

```typescript
import { expect, test } from "bun:test";

import { DEFAULT_NIMBUS_GLOSSARY_TOML, parseNimbusGlossaryToml } from "./nimbus-toml.ts";

test("defaults are enabled with the documented caps", () => {
  expect(DEFAULT_NIMBUS_GLOSSARY_TOML.enabled).toBe(true);
  expect(DEFAULT_NIMBUS_GLOSSARY_TOML.maxNewTermsPerPass).toBe(25);
  expect(DEFAULT_NIMBUS_GLOSSARY_TOML.statsRecheckPerPass).toBe(50);
  expect(DEFAULT_NIMBUS_GLOSSARY_TOML.statsRecheckCooldownMs).toBe(43_200_000);
  expect(DEFAULT_NIMBUS_GLOSSARY_TOML.retryBaseCooldownMs).toBe(900_000);
  expect(DEFAULT_NIMBUS_GLOSSARY_TOML.minDocFreq).toBe(3);
  expect(DEFAULT_NIMBUS_GLOSSARY_TOML.debounceMs).toBe(60000);
  expect(DEFAULT_NIMBUS_GLOSSARY_TOML.consolidateTimeoutMs).toBe(30000);
});

test("an absent section yields the defaults", () => {
  expect(parseNimbusGlossaryToml("")).toEqual(DEFAULT_NIMBUS_GLOSSARY_TOML);
});

test("parses every key", () => {
  const raw = [
    "[glossary]",
    "enabled = false",
    "max_new_terms_per_pass = 5",
    "stats_recheck_per_pass = 10",
    "stats_recheck_cooldown_ms = 3600000",
    "retry_base_cooldown_ms = 60000",
    "min_doc_freq = 7",
    "debounce_ms = 1000",
    "consolidate_timeout_ms = 2000",
  ].join("\n");
  const cfg = parseNimbusGlossaryToml(raw);
  expect(cfg.enabled).toBe(false);
  expect(cfg.maxNewTermsPerPass).toBe(5);
  expect(cfg.statsRecheckPerPass).toBe(10);
  expect(cfg.statsRecheckCooldownMs).toBe(3_600_000);
  expect(cfg.retryBaseCooldownMs).toBe(60_000);
  expect(cfg.minDocFreq).toBe(7);
  expect(cfg.debounceMs).toBe(1000);
  expect(cfg.consolidateTimeoutMs).toBe(2000);
});

test("non-positive numbers are rejected in favour of the default", () => {
  const cfg = parseNimbusGlossaryToml("[glossary]\nmin_doc_freq = 0\n");
  expect(cfg.minDocFreq).toBe(3);
});

test("an unknown key is ignored", () => {
  expect(() => parseNimbusGlossaryToml("[glossary]\nbogus = 1\n")).not.toThrow();
});
```

- [ ] **Step 2: Add the config block**

In `packages/gateway/src/config/nimbus-toml.ts`, after the `[briefs]` block (around line 1474), add:

```typescript
// ---------------------------------------------------------------------------
// [glossary] — implicit-knowledge glossary (Spine S1)
// ---------------------------------------------------------------------------

export type NimbusGlossaryToml = {
  /**
   * Default ON, unlike [briefs]. Briefs open an HTTP write surface; the
   * glossary opens nothing — it reads the local index and writes local rows.
   */
  enabled: boolean;
  /** LLM calls per pass (sequential). */
  maxNewTermsPerPass: number;
  /** Reconciliation sweep width — pure SQL, no LLM cost. */
  statsRecheckPerPass: number;
  /** Skip re-verifying a term checked more recently than this (default 12 h). */
  statsRecheckCooldownMs: number;
  minDocFreq: number;
  debounceMs: number;
  consolidateTimeoutMs: number;
  /** Base for the exponential retry backoff that prevents queue starvation. */
  retryBaseCooldownMs: number;
};

export const DEFAULT_NIMBUS_GLOSSARY_TOML: NimbusGlossaryToml = {
  enabled: true,
  maxNewTermsPerPass: 25,
  statsRecheckPerPass: 50,
  statsRecheckCooldownMs: 12 * 60 * 60 * 1000,
  minDocFreq: 3,
  debounceMs: 60000,
  consolidateTimeoutMs: 30000,
  retryBaseCooldownMs: 15 * 60 * 1000,
};

function applyNimbusGlossaryKey(
  out: Partial<NimbusGlossaryToml>,
  key: string,
  valRaw: string,
): void {
  if (key === "enabled") {
    const b = parseBool(valRaw);
    if (b !== undefined) out.enabled = b;
    return;
  }
  const n = parseIntDec(valRaw);
  if (n === undefined || n <= 0) return;
  switch (key) {
    case "max_new_terms_per_pass":
      out.maxNewTermsPerPass = n;
      break;
    case "stats_recheck_per_pass":
      out.statsRecheckPerPass = n;
      break;
    case "stats_recheck_cooldown_ms":
      out.statsRecheckCooldownMs = n;
      break;
    case "retry_base_cooldown_ms":
      out.retryBaseCooldownMs = n;
      break;
    case "min_doc_freq":
      out.minDocFreq = n;
      break;
    case "debounce_ms":
      out.debounceMs = n;
      break;
    case "consolidate_timeout_ms":
      out.consolidateTimeoutMs = n;
      break;
    default:
      break;
  }
}

export function parseNimbusGlossaryToml(
  raw: string,
  defaults: NimbusGlossaryToml = DEFAULT_NIMBUS_GLOSSARY_TOML,
): NimbusGlossaryToml {
  const out: Partial<NimbusGlossaryToml> = {};
  forEachSectionEntry(raw, "[glossary]", (key, valRaw) => applyNimbusGlossaryKey(out, key, valRaw));
  return { ...defaults, ...out };
}
```

Then add a `loadNimbusGlossaryFromConfigDir` following the exact shape of the neighbouring `loadNimbus<X>FromConfigDir` helper for `[briefs]` in the same file (it wraps `loadTomlSection`, which already returns defaults on a missing file or parse error).

- [ ] **Step 3: Run the config test**

Run: `bun test packages/gateway/src/config/nimbus-toml-glossary.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 4: Write the failing refresher test**

Create `packages/gateway/src/glossary/glossary-refresh.test.ts`:

```typescript
import { expect, test } from "bun:test";

import { createGlossaryRefresher } from "./glossary-refresh.ts";

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve = (): void => undefined;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

test("a trigger runs the pass after the debounce window", async () => {
  let runs = 0;
  const r = createGlossaryRefresher({
    enabled: true,
    debounceMs: 5,
    runPass: async () => {
      runs += 1;
    },
  });
  r.trigger();
  await Bun.sleep(30);
  expect(runs).toBe(1);
  r.stop();
});

test("a burst of triggers coalesces into one pass", async () => {
  let runs = 0;
  const r = createGlossaryRefresher({
    enabled: true,
    debounceMs: 15,
    runPass: async () => {
      runs += 1;
    },
  });
  r.trigger();
  r.trigger();
  r.trigger();
  await Bun.sleep(50);
  expect(runs).toBe(1);
  r.stop();
});

test("a trigger during an in-flight pass is dropped, not queued", async () => {
  let runs = 0;
  const gate = deferred();
  const r = createGlossaryRefresher({
    enabled: true,
    debounceMs: 1,
    runPass: async () => {
      runs += 1;
      await gate.promise;
    },
  });
  r.trigger();
  await Bun.sleep(15);
  r.trigger();
  await Bun.sleep(15);
  gate.resolve();
  await Bun.sleep(15);
  expect(runs).toBe(1);
  r.stop();
});

test("disabled never runs the pass", async () => {
  let runs = 0;
  const r = createGlossaryRefresher({
    enabled: false,
    debounceMs: 1,
    runPass: async () => {
      runs += 1;
    },
  });
  r.trigger();
  await Bun.sleep(20);
  expect(runs).toBe(0);
  r.stop();
});

test("stop cancels a pending trigger", async () => {
  let runs = 0;
  const r = createGlossaryRefresher({
    enabled: true,
    debounceMs: 20,
    runPass: async () => {
      runs += 1;
    },
  });
  r.trigger();
  r.stop();
  await Bun.sleep(40);
  expect(runs).toBe(0);
});

test("a thrown pass does not wedge the refresher", async () => {
  let runs = 0;
  const r = createGlossaryRefresher({
    enabled: true,
    debounceMs: 5,
    runPass: async () => {
      runs += 1;
      throw new Error("boom");
    },
  });
  r.trigger();
  await Bun.sleep(25);
  r.trigger();
  await Bun.sleep(25);
  expect(runs).toBe(2);
  r.stop();
});
```

- [ ] **Step 5: Implement the refresher**

Create `packages/gateway/src/glossary/glossary-refresh.ts`:

```typescript
export type GlossaryRefresherDeps = {
  enabled: boolean;
  debounceMs: number;
  /** Injected rather than imported so the module is testable without a Database. */
  runPass: () => Promise<void>;
  onError?: (err: unknown) => void;
};

export type GlossaryRefresher = {
  /** Called after each successful connector sync. Cheap and non-blocking. */
  trigger: () => void;
  stop: () => void;
};

/**
 * Debounced, single-flight trigger for the extraction pass.
 *
 * A burst of connector syncs must coalesce into ONE pass, and a trigger
 * arriving while a pass is running is DROPPED rather than queued — the next
 * sync will trigger again anyway, and queueing would let a slow pass build an
 * unbounded backlog of redundant work.
 */
export function createGlossaryRefresher(deps: GlossaryRefresherDeps): GlossaryRefresher {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let running = false;

  function fire(): void {
    timer = undefined;
    if (running) return;
    running = true;
    deps
      .runPass()
      .catch((err: unknown) => {
        deps.onError?.(err);
      })
      .finally(() => {
        running = false;
      });
  }

  return {
    trigger(): void {
      if (!deps.enabled) return;
      if (timer !== undefined) clearTimeout(timer);
      timer = setTimeout(fire, deps.debounceMs);
    },
    stop(): void {
      if (timer !== undefined) clearTimeout(timer);
      timer = undefined;
    },
  };
}
```

- [ ] **Step 6: Run the refresher test**

Run: `bun test packages/gateway/src/glossary/glossary-refresh.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 7: Wire into the scheduler seam**

In `packages/gateway/src/platform/assemble.ts`, inside `createSchedulerWithMesh`, construct the refresher before `new SyncScheduler(...)`:

```typescript
  const glossaryCfg = loadNimbusGlossaryFromConfigDir(paths.configDir);
  const glossaryRefresher = createGlossaryRefresher({
    enabled: glossaryCfg.enabled,
    debounceMs: glossaryCfg.debounceMs,
    runPass: async () => {
      await runGlossaryPass(db, {
        maxNewTermsPerPass: glossaryCfg.maxNewTermsPerPass,
        statsRecheckPerPass: glossaryCfg.statsRecheckPerPass,
        statsRecheckCooldownMs: glossaryCfg.statsRecheckCooldownMs,
        minDocFreq: glossaryCfg.minDocFreq,
        consolidateTimeoutMs: glossaryCfg.consolidateTimeoutMs,
        retryBaseCooldownMs: glossaryCfg.retryBaseCooldownMs,
        nowMs: Date.now(),
      });
    },
    onError: (err) => {
      syncLogger.warn({ err }, "glossary extraction pass failed");
    },
  });
```

Then add one line to the existing `onConnectorSyncSuccess` callback, immediately after the `evaluateWatchersAfterSync(...)` call:

```typescript
      glossaryRefresher.trigger();
```

The pass runs without an LLM here; definitions are snippet-sourced until an LLM-backed path is wired in a follow-up. That is the documented degradation (spec §5.7), not a gap.

- [ ] **Step 8: Verify the gateway still builds and boots**

Run: `bun run typecheck`
Expected: PASS.

Run: `bun test packages/gateway/src/platform/`
Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add packages/gateway/src/config/nimbus-toml.ts packages/gateway/src/config/nimbus-toml-glossary.test.ts packages/gateway/src/glossary/glossary-refresh.ts packages/gateway/src/glossary/glossary-refresh.test.ts packages/gateway/src/platform/assemble.ts
git commit -m "feat(glossary): [glossary] config and debounced post-sync refresh trigger"
```

---

### Task 13: The agent (4 lanes) + rendering

**Files:**
- Create: `packages/gateway/src/agents/_lib/glossary-types.ts`
- Create: `packages/gateway/src/agents/glossary.ts`
- Modify: `packages/gateway/src/agents/_lib/render.ts`
- Modify: `packages/gateway/src/agents/_lib/synthesize.ts`
- Modify: `packages/gateway/src/agents/_lib/emit-brief.ts`
- Test: `packages/gateway/src/agents/glossary.test.ts`

**Interfaces:**
- Consumes: `AgentCoordinator`, `SubTask` from `../engine/coordinator.ts`; `emitBriefWithSynthesis`; `GapNote`; store readers (Task 7); `normalizeTerm` (Task 3); `findNearMisses` (Task 6).
- Produces: `GlossaryBrief`, `GlossaryEntry`, `GlossaryInput`, `runGlossary(input, ctx): Promise<GlossaryBrief>`, `emitGlossaryBrief(input, ctx): Promise<{ sessionId: string }>`, `renderGlossary(brief): string`.

**Do NOT add these types to `findings.ts`** — that file re-exports from `@nimbus-dev/sdk`, a separate published repo. Local types now; SDK promotion is a follow-up (the `why` precedent).

- [ ] **Step 1: Write the brief types**

Create `packages/gateway/src/agents/_lib/glossary-types.ts`:

```typescript
import type { GapNote } from "./findings.ts";

/** Request params — client-local, like every other agent's input type. */
export type GlossaryInput = {
  term?: string;
  limit?: number;
};

export type GlossarySourceRef = {
  itemId: string;
  title: string;
  url: string | null;
  service: string;
  modifiedAt: number;
};

export type GlossaryEntry = {
  term: string;
  definition: string | null;
  definitionSource: "llm" | "snippet" | null;
  docFreq: number;
  serviceSpread: number;
  firstSeenAt: number;
  lastSeenAt: number;
  topSources: GlossarySourceRef[];
  synonyms: string[];
  nearMisses: string[];
};

export type GlossaryBrief = {
  kind: "glossary";
  agentVersion: number;
  generatedAt: number;
  latencyMs: number;
  gaps: GapNote[];
  query: { term: string | null; limit: number };
  /** `term` = resolved; `miss` = unknown term with suggestions; `list` = no argument. */
  mode: "list" | "term" | "miss";
  entries: GlossaryEntry[];
  matchedVia: "exact" | "synonym" | null;
  suggestions: string[];
  stats: { total: number; pending: number; vetoed: number; lastPassAt: number | null };
};
```

- [ ] **Step 2: Write the failing agent test**

Create `packages/gateway/src/agents/glossary.test.ts`:

```typescript
import { Database } from "bun:sqlite";
import { beforeEach, expect, test } from "bun:test";

import { CURRENT_SCHEMA_VERSION } from "../index/local-index.ts";
import { runIndexedSchemaMigrations } from "../index/migrations/runner.ts";

/** There is no `runMigrations` export — this wrapper matches every other test in the repo. */
function runMigrations(db: Database): void {
  runIndexedSchemaMigrations(db, CURRENT_SCHEMA_VERSION);
}
import { markConsolidated, upsertCandidate } from "../glossary/glossary-store.ts";
import { runGlossary } from "./glossary.ts";

let db: Database;

function seed(key: string, opts: { score?: number; synonyms?: string[] } = {}): void {
  upsertCandidate(db, {
    key,
    surface: key.toUpperCase(),
    form: "acronym",
    stats: { docFreq: 4, serviceSpread: 2, firstSeenAt: 100, lastSeenAt: 900, topSources: [] },
    score: opts.score ?? 1,
    nowMs: 1000,
  });
  markConsolidated(db, {
    termKey: key,
    definition: `definition of ${key}`,
    definitionSource: "llm",
    synonyms: opts.synonyms ?? [],
    nearMisses: [],
    nowMs: 1000,
  });
}

function ctx() {
  return { db, notify: () => undefined, sessionId: "s1" };
}

beforeEach(() => {
  db = new Database(":memory:");
  runMigrations(db);
});

test("no argument returns a frequency-ranked list", async () => {
  seed("cdr", { score: 9 });
  seed("slo", { score: 2 });
  const brief = await runGlossary({}, ctx());
  expect(brief.mode).toBe("list");
  expect(brief.entries.map((e) => e.term)).toEqual(["CDR", "SLO"]);
});

test("an exact term returns its consolidated definition", async () => {
  seed("cdr");
  const brief = await runGlossary({ term: "CDR" }, ctx());
  expect(brief.mode).toBe("term");
  expect(brief.matchedVia).toBe("exact");
  expect(brief.entries[0]?.definition).toBe("definition of cdr");
});

test("a plural query resolves to the singular key", async () => {
  seed("slo");
  const brief = await runGlossary({ term: "SLOs" }, ctx());
  expect(brief.mode).toBe("term");
});

test("a synonym resolves to the canonical term", async () => {
  seed("cdr", { synonyms: ["Change Data Record"] });
  const brief = await runGlossary({ term: "Change Data Record" }, ctx());
  expect(brief.mode).toBe("term");
  expect(brief.matchedVia).toBe("synonym");
  expect(brief.entries[0]?.term).toBe("CDR");
});

test("an unknown term returns near-miss suggestions rather than nothing", async () => {
  seed("cdr");
  const brief = await runGlossary({ term: "CDC" }, ctx());
  expect(brief.mode).toBe("miss");
  expect(brief.entries).toEqual([]);
  expect(brief.suggestions).toContain("cdr");
});

test("an unknown term with no close match still returns a miss brief", async () => {
  seed("cdr");
  const brief = await runGlossary({ term: "kubernetes" }, ctx());
  expect(brief.mode).toBe("miss");
  expect(brief.suggestions).toEqual([]);
});

test("an empty glossary reports a gap note", async () => {
  const brief = await runGlossary({}, ctx());
  expect(brief.entries).toEqual([]);
  expect(brief.gaps.length).toBeGreaterThan(0);
});

test("pending terms are reported in the stats", async () => {
  upsertCandidate(db, {
    key: "wip",
    surface: "WIP",
    form: "acronym",
    stats: { docFreq: 3, serviceSpread: 1, firstSeenAt: 1, lastSeenAt: 2, topSources: [] },
    score: 1,
    nowMs: 1000,
  });
  const brief = await runGlossary({}, ctx());
  expect(brief.stats.pending).toBe(1);
});

test("the limit is honoured", async () => {
  seed("cdr", { score: 9 });
  seed("slo", { score: 5 });
  seed("rpo", { score: 1 });
  const brief = await runGlossary({ limit: 2 }, ctx());
  expect(brief.entries.length).toBe(2);
});

test("the brief carries latency and a version", async () => {
  seed("cdr");
  const brief = await runGlossary({}, ctx());
  expect(brief.kind).toBe("glossary");
  expect(brief.agentVersion).toBe(1);
  expect(brief.latencyMs).toBeGreaterThanOrEqual(0);
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `bun test packages/gateway/src/agents/glossary.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 4: Implement the agent**

Create `packages/gateway/src/agents/glossary.ts`:

```typescript
import type { Database } from "bun:sqlite";

import { AgentCoordinator, type SubTask } from "../engine/coordinator.ts";
import {
  countByStatus,
  findBySynonym,
  getTerm,
  listAllKeys,
  listConsolidated,
  readPassState,
} from "../glossary/glossary-store.ts";
import type { GlossaryTerm } from "../glossary/glossary-types.ts";
import { findNearMisses } from "../glossary/near-miss.ts";
import { normalizeTerm } from "../glossary/term-normalize.ts";
import { emitBriefWithSynthesis } from "./_lib/emit-brief.ts";
import type { GapNote } from "./_lib/findings.ts";
import type {
  GlossaryBrief,
  GlossaryEntry,
  GlossaryInput,
} from "./_lib/glossary-types.ts";
import type { SynthesizerLlm } from "./_lib/synthesize.ts";

export type GlossaryContext = {
  db: Database;
  notify: (method: string, params: unknown) => void;
  sessionId: string;
  llm?: SynthesizerLlm;
};

const DEFAULT_LIMIT = 50;

function toEntry(t: GlossaryTerm): GlossaryEntry {
  return {
    term: t.displayTerm,
    definition: t.definition,
    definitionSource: t.definitionSource,
    docFreq: t.docFreq,
    serviceSpread: t.serviceSpread,
    firstSeenAt: t.firstSeenAt,
    lastSeenAt: t.lastSeenAt,
    topSources: t.topSources,
    synonyms: t.synonyms,
    nearMisses: t.nearMisses,
  };
}

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

/**
 * Resolves a query in the documented order: exact key, then synonym, then
 * near-miss suggestions.
 *
 * Synonym resolution is not polish — the motivating user encounters the
 * EXPANDED phrase and wants the team's meaning. Requiring them to already know
 * the acronym would invert the feature.
 */
function resolveTerm(
  db: Database,
  raw: string,
): { term: GlossaryTerm | null; matchedVia: "exact" | "synonym" | null } {
  const key = normalizeTerm(raw);
  if (key === "") return { term: null, matchedVia: null };

  const exact = getTerm(db, key);
  if (exact !== null && exact.status === "consolidated") {
    return { term: exact, matchedVia: "exact" };
  }
  const bySynonym = findBySynonym(db, key);
  if (bySynonym !== null) return { term: bySynonym, matchedVia: "synonym" };

  return { term: null, matchedVia: null };
}

function buildGaps(
  db: Database,
  counts: { total: number; pending: number; vetoed: number },
  lastPassAt: number | null,
): GapNote[] {
  const gaps: GapNote[] = [];
  const anyItems = db.query("SELECT 1 FROM item LIMIT 1").get() !== null;

  if (!anyItems) {
    gaps.push({
      category: "empty_index",
      detail: "The local index is empty, so no terminology could be extracted.",
      remediation: "Connect a source and run a sync, then try again.",
    });
    return gaps;
  }
  if (lastPassAt === null) {
    gaps.push({
      category: "missing_connector",
      detail: "The glossary extraction pass has not run yet.",
      remediation: "Run `nimbus glossary --refresh`, or wait for the next connector sync.",
    });
    return gaps;
  }
  if (counts.total === 0) {
    gaps.push({
      category: "missing_connector",
      detail: "A pass ran but no candidate met the minimum document frequency.",
      remediation: "Lower `[glossary].min_doc_freq`, or index more discussion sources.",
    });
  }
  if (counts.pending > 0) {
    gaps.push({
      category: "missing_connector",
      detail: `${String(counts.pending)} candidate term(s) are still awaiting consolidation.`,
      remediation: "The glossary fills in progressively — later passes will consolidate them.",
    });
  }
  return gaps;
}

export async function runGlossary(
  input: GlossaryInput,
  ctx: GlossaryContext,
): Promise<GlossaryBrief> {
  const start = performance.now();
  const limit = input.limit ?? DEFAULT_LIMIT;
  const rawTerm = input.term?.trim() ?? "";

  const coordinator = new AgentCoordinator({
    sessionId: ctx.sessionId,
    parentId: `glossary:${ctx.sessionId}`,
    depth: 1,
    toolCallCount: { value: 0 },
  });

  const counts = countByStatus(ctx.db);
  const passState = readPassState(ctx.db);

  let mode: GlossaryBrief["mode"];
  let entries: GlossaryEntry[] = [];
  let matchedVia: "exact" | "synonym" | null = null;
  let suggestions: string[] = [];

  if (rawTerm === "") {
    // List mode: ranked list / coverage stats / gap notes.
    const tasks: SubTask[] = [
      subAgent(() => listConsolidated(ctx.db, limit)),
      subAgent(() => countByStatus(ctx.db)),
      subAgent(() => buildGaps(ctx.db, counts, passState.lastPassAt)),
    ];
    const results = await coordinator.run(tasks);
    const terms = decode<GlossaryTerm[]>(results[0]?.text, []);
    entries = terms.map(toEntry);
    mode = "list";
    const gaps = decode<GapNote[]>(results[2]?.text, []);
    return {
      kind: "glossary",
      agentVersion: 1,
      generatedAt: Date.now(),
      latencyMs: Math.round(performance.now() - start),
      gaps,
      query: { term: null, limit },
      mode,
      entries,
      matchedVia: null,
      suggestions: [],
      stats: { ...counts, lastPassAt: passState.lastPassAt },
    };
  }

  // Term mode: resolution / source hydration / synonyms / near-misses.
  const tasks: SubTask[] = [
    subAgent(() => resolveTerm(ctx.db, rawTerm)),
    subAgent(() => {
      const r = resolveTerm(ctx.db, rawTerm);
      return r.term === null ? [] : r.term.topSources;
    }),
    subAgent(() => {
      const r = resolveTerm(ctx.db, rawTerm);
      return r.term === null ? [] : r.term.synonyms;
    }),
    subAgent(() => findNearMisses(normalizeTerm(rawTerm), listAllKeys(ctx.db))),
  ];
  const results = await coordinator.run(tasks);

  const resolved = decode<{ term: GlossaryTerm | null; matchedVia: "exact" | "synonym" | null }>(
    results[0]?.text,
    { term: null, matchedVia: null },
  );
  const nearMisses = decode<string[]>(results[3]?.text, []);

  if (resolved.term === null) {
    mode = "miss";
    suggestions = nearMisses;
  } else {
    mode = "term";
    matchedVia = resolved.matchedVia;
    entries = [toEntry(resolved.term)];
  }

  return {
    kind: "glossary",
    agentVersion: 1,
    generatedAt: Date.now(),
    latencyMs: Math.round(performance.now() - start),
    gaps: buildGaps(ctx.db, counts, passState.lastPassAt),
    query: { term: rawTerm, limit },
    mode,
    entries,
    matchedVia,
    suggestions,
    stats: { ...counts, lastPassAt: passState.lastPassAt },
  };
}

export function emitGlossaryBrief(
  input: GlossaryInput,
  ctx: GlossaryContext,
): Promise<{ sessionId: string }> {
  return emitBriefWithSynthesis({
    sessionId: ctx.sessionId,
    briefReadyMethod: "glossary.briefReady",
    briefErrorMethod: "glossary.briefError",
    notify: ctx.notify,
    ...(ctx.llm === undefined ? {} : { llm: ctx.llm }),
    buildBrief: () => runGlossary(input, ctx),
  });
}
```

- [ ] **Step 5: Add the renderer**

In `packages/gateway/src/agents/_lib/render.ts`, add the import and the function:

```typescript
import type { GlossaryBrief } from "./glossary-types.ts";

function isoDay(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

export function renderGlossary(brief: GlossaryBrief): string {
  const lines: string[] = ["# Glossary"];

  if (brief.mode === "miss") {
    lines.push(`\n_No glossary entry for \`${brief.query.term ?? ""}\`._`);
    if (brief.suggestions.length > 0) {
      lines.push(`\n**Did you mean:** ${brief.suggestions.join(", ")}`);
    }
  } else if (brief.mode === "term") {
    const e = brief.entries[0];
    if (e !== undefined) {
      lines.push(`\n## ${e.term}`);
      if (brief.matchedVia === "synonym") {
        lines.push(`_Matched via synonym "${brief.query.term ?? ""}"._`);
      }
      lines.push(`\n${e.definition ?? "_No definition yet._"}`);
      lines.push(
        `\n- Seen in ${String(e.docFreq)} item(s) across ${String(e.serviceSpread)} service(s)`,
      );
      lines.push(`- First seen ${isoDay(e.firstSeenAt)}, last seen ${isoDay(e.lastSeenAt)}`);
      if (e.synonyms.length > 0) lines.push(`- Also known as: ${e.synonyms.join(", ")}`);
      if (e.nearMisses.length > 0) lines.push(`- Easily confused with: ${e.nearMisses.join(", ")}`);
      if (e.definitionSource === "snippet") {
        lines.push("- _Definition quoted verbatim from a source; no LLM configured._");
      }
      if (e.topSources.length > 0) {
        lines.push("\n### Sources");
        for (const s of e.topSources) {
          const head = s.url === null ? s.title : `[${s.title}](${s.url})`;
          lines.push(`- ${head} — ${s.service}, ${isoDay(s.modifiedAt)}`);
        }
      }
    }
  } else if (brief.entries.length === 0) {
    lines.push("\n_No terms extracted yet._");
  } else {
    lines.push("");
    for (const e of brief.entries) {
      lines.push(`- **${e.term}** — ${String(e.docFreq)} mention(s)`);
    }
  }

  const gaps = renderGaps(brief.gaps);
  if (gaps !== "") lines.push(gaps);
  lines.push(renderLatency(brief.latencyMs));
  return lines.join("\n");
}
```

- [ ] **Step 6: Wire the unions**

In `packages/gateway/src/agents/_lib/synthesize.ts`: add `import type { GlossaryBrief } from "./glossary-types.ts";`, add `| GlossaryBrief` to `SynthInput`, add `renderGlossary` to the `render.ts` import, and add these two lines before the final `return` of each switch helper:

```typescript
  if (brief.kind === "glossary") return renderGlossary(brief);
```
```typescript
  if (brief.kind === "glossary") return "agents.glossary";
```

In `packages/gateway/src/agents/_lib/emit-brief.ts`: add `import type { GlossaryBrief } from "./glossary-types.ts";` and `| GlossaryBrief` to the `AnyBrief` union.

- [ ] **Step 7: Run the agent tests**

Run: `bun test packages/gateway/src/agents/`
Expected: PASS, including the existing agent suites.

- [ ] **Step 8: Confirm the read-only property**

Run: `grep -n "ToolExecutor\|HITL_REQUIRED" packages/gateway/src/agents/glossary.ts`
Expected: no output. If anything matches, the agent has stopped being read-only.

- [ ] **Step 9: Commit**

```bash
git add packages/gateway/src/agents/
git commit -m "feat(glossary): four-lane read-only agent with synonym resolution"
```

---

### Task 14: IPC method + Tauri allowlist

**Files:**
- Modify: `packages/gateway/src/ipc/agents-rpc.ts`
- Modify: `packages/ui/src-tauri/src/gateway_bridge.rs`
- Test: `packages/gateway/src/ipc/agents-rpc.glossary.test.ts`

**Interfaces:**
- Consumes: `emitGlossaryBrief` (Task 13); `dispatchByMethod`, `AgentsRpcError`, `newSessionId` (existing in `agents-rpc.ts`).
- Produces: IPC method `agents.glossary { term?: string; limit?: number }` → `{ sessionId: string }`, followed by `glossary.briefReady` / `glossary.briefError`.

- [ ] **Step 1: Write the failing IPC test**

Create `packages/gateway/src/ipc/agents-rpc.glossary.test.ts`, mirroring the structure of the existing `agents-rpc.why.test.ts` (read it first for `makeCtx` / `freshDb`):

```typescript
import { describe, expect, test } from "bun:test";

import { dispatchAgentsRpc } from "./agents-rpc.ts";
// Reuse the helpers from the sibling why test — copy `makeCtx` and `freshDb`
// verbatim from `agents-rpc.why.test.ts` into this file.

describe("dispatchAgentsRpc — agents.glossary", () => {
  test("returns a sessionId with no argument", async () => {
    const out = await dispatchAgentsRpc("agents.glossary", {}, makeCtx(freshDb()));
    expect(out.hit).toBe(true);
  });

  test("accepts a term", async () => {
    const out = await dispatchAgentsRpc("agents.glossary", { term: "CDR" }, makeCtx(freshDb()));
    expect(out.hit).toBe(true);
  });

  test("rejects a non-string term", async () => {
    await expect(
      dispatchAgentsRpc("agents.glossary", { term: 5 }, makeCtx(freshDb())),
    ).rejects.toMatchObject({ code: -32602 });
  });

  test("rejects a non-positive limit", async () => {
    await expect(
      dispatchAgentsRpc("agents.glossary", { limit: 0 }, makeCtx(freshDb())),
    ).rejects.toMatchObject({ code: -32602 });
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun test packages/gateway/src/ipc/agents-rpc.glossary.test.ts`
Expected: FAIL — the method is a miss.

- [ ] **Step 3: Add the handler**

In `packages/gateway/src/ipc/agents-rpc.ts`, add the import:

```typescript
import { emitGlossaryBrief } from "../agents/glossary.ts";
import type { GlossaryInput } from "../agents/_lib/glossary-types.ts";
```

Add the params guard and handler next to `handleWhy`:

```typescript
function requireGlossaryParams(params: unknown): GlossaryInput {
  if (params === null || typeof params !== "object") return {};
  const p = params as { term?: unknown; limit?: unknown };
  if (p.term !== undefined && typeof p.term !== "string") {
    throw new AgentsRpcError(-32602, "term must be a string");
  }
  if (
    p.limit !== undefined &&
    (typeof p.limit !== "number" || !Number.isInteger(p.limit) || p.limit < 1)
  ) {
    throw new AgentsRpcError(-32602, "limit must be a positive integer");
  }
  return {
    ...(p.term === undefined ? {} : { term: p.term }),
    ...(p.limit === undefined ? {} : { limit: p.limit as number }),
  };
}

async function handleGlossary(
  params: unknown,
  ctx: AgentsRpcContext,
): Promise<{ sessionId: string }> {
  const input = requireGlossaryParams(params);
  return await emitGlossaryBrief(input, {
    db: ctx.db,
    notify: ctx.notify,
    sessionId: newSessionId("glossary"),
    ...(ctx.llm === undefined ? {} : { llm: ctx.llm }),
  });
}
```

Register it in the `dispatchByMethod` table, after `"agents.whyPeek": handleWhyPeek`:

```typescript
    "agents.glossary": handleGlossary,
```

- [ ] **Step 4: Add the Tauri allowlist entry**

In `packages/ui/src-tauri/src/gateway_bridge.rs`, add `"agents.glossary",` to `ALLOWED_METHODS` next to the other `agents.*` entries, and update the count assertion near line 518 from `101` to `102`.

The method is read-only and non-RCE, so renderer exposure is safe (**I7**).

- [ ] **Step 5: Run the tests**

Run: `bun test packages/gateway/src/ipc/`
Expected: PASS. Update any count assertion on the agents dispatch table that now expects one more method.

Run: `cd packages/ui/src-tauri && cargo test allowed_methods`
Expected: PASS with 102.

- [ ] **Step 6: Commit**

```bash
git add packages/gateway/src/ipc/ packages/ui/src-tauri/src/gateway_bridge.rs
git commit -m "feat(glossary): agents.glossary IPC method and Tauri allowlist entry"
```

---

### Task 15: CLI command

**Files:**
- Create: `packages/cli/src/commands/glossary.ts`
- Modify: `packages/cli/src/index.ts`
- Test: `packages/cli/src/commands/glossary.test.ts`

**Interfaces:**
- Consumes: `runAgentBriefCli`, `flagValue` from `./_agent-brief-cli.ts`.
- Produces: `parseGlossaryArgs(args: string[]): GlossaryCliArgs`, `runGlossaryCommand(args: string[]): Promise<void>`.

The CLI **cannot import gateway source** (IPC-only rule) and `@nimbus-dev/sdk` has no glossary types, so this file carries a local structural guard — the same stand-in `why.ts` uses.

**Test with dependency injection, never `mock.module`** — it leaks process-globally in the combined `bun test packages/cli/src` run on CI-Linux and the failure does not reproduce on Windows.

- [ ] **Step 1: Write the failing test**

Create `packages/cli/src/commands/glossary.test.ts`:

```typescript
import { expect, test } from "bun:test";

import { isGlossaryBriefLike, parseGlossaryArgs } from "./glossary.ts";

test("no arguments yields a list request", () => {
  const a = parseGlossaryArgs([]);
  expect(a.term).toBeUndefined();
  expect(a.json).toBe(false);
});

test("a positional argument becomes the term", () => {
  expect(parseGlossaryArgs(["CDR"]).term).toBe("CDR");
});

test("a multi-word term is joined", () => {
  expect(parseGlossaryArgs(["Change", "Data", "Record"]).term).toBe("Change Data Record");
});

test("--json sets the json flag", () => {
  expect(parseGlossaryArgs(["--json"]).json).toBe(true);
});

test("--limit parses a positive integer", () => {
  expect(parseGlossaryArgs(["--limit", "10"]).limit).toBe(10);
});

test("--limit rejects a non-positive value", () => {
  expect(() => parseGlossaryArgs(["--limit", "0"])).toThrow();
});

test("--limit rejects a missing value", () => {
  expect(() => parseGlossaryArgs(["--limit"])).toThrow();
});

test("--refresh and --rebuild are recognised and mutually exclusive", () => {
  expect(parseGlossaryArgs(["--refresh"]).refresh).toBe(true);
  expect(parseGlossaryArgs(["--rebuild"]).rebuild).toBe(true);
  expect(() => parseGlossaryArgs(["--refresh", "--rebuild"])).toThrow();
});

test("flags combine with a term", () => {
  const a = parseGlossaryArgs(["CDR", "--json"]);
  expect(a.term).toBe("CDR");
  expect(a.json).toBe(true);
});

test("isGlossaryBriefLike accepts a well-formed brief", () => {
  expect(isGlossaryBriefLike({ kind: "glossary", entries: [], gaps: [], mode: "list" })).toBe(true);
});

test("isGlossaryBriefLike rejects malformed payloads", () => {
  expect(isGlossaryBriefLike(null)).toBe(false);
  expect(isGlossaryBriefLike({ kind: "why", entries: [], gaps: [], mode: "list" })).toBe(false);
  expect(isGlossaryBriefLike({ kind: "glossary", entries: "no", gaps: [], mode: "list" })).toBe(false);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun test packages/cli/src/commands/glossary.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the command**

Create `packages/cli/src/commands/glossary.ts`:

```typescript
import { flagValue, runAgentBriefCli } from "./_agent-brief-cli.ts";

export type GlossaryCliArgs = {
  term?: string;
  limit?: number;
  refresh: boolean;
  rebuild: boolean;
  json: boolean;
};

/**
 * Local structural stand-in for the gateway's `GlossaryBrief`
 * (`agents/_lib/glossary-types.ts`). The CLI cannot import gateway source
 * (IPC-only rule) and `@nimbus-dev/sdk` has no glossary types yet — a future
 * SDK promotion replaces this, exactly as it did for `why`.
 */
export type GlossaryBriefLike = {
  kind: "glossary";
  mode: string;
  entries: unknown[];
  gaps: unknown[];
};

export function isGlossaryBriefLike(v: unknown): v is GlossaryBriefLike {
  if (v === null || typeof v !== "object") return false;
  const b = v as { kind?: unknown; mode?: unknown; entries?: unknown; gaps?: unknown };
  return (
    b.kind === "glossary" &&
    typeof b.mode === "string" &&
    Array.isArray(b.entries) &&
    Array.isArray(b.gaps)
  );
}

const USAGE = "Usage: nimbus glossary [<term>] [--limit <n>] [--refresh | --rebuild] [--json]";

function parseLimit(raw: string): number {
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1) throw new Error("--limit must be a positive integer");
  return n;
}

export function parseGlossaryArgs(args: string[]): GlossaryCliArgs {
  const positional: string[] = [];
  let limit: number | undefined;
  let refresh = false;
  let rebuild = false;
  let json = false;

  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--limit") {
      limit = parseLimit(flagValue(args, i, "--limit"));
      i += 1;
    } else if (a === "--refresh") {
      refresh = true;
    } else if (a === "--rebuild") {
      rebuild = true;
    } else if (a === "--json") {
      json = true;
    } else if (a === "--help" || a === "-h") {
      throw new Error(USAGE);
    } else if (typeof a === "string" && a.startsWith("--")) {
      throw new Error(`Unknown flag: ${a}\n${USAGE}`);
    } else if (typeof a === "string") {
      positional.push(a);
    }
  }

  if (refresh && rebuild) {
    throw new Error("--refresh and --rebuild are mutually exclusive");
  }

  const term = positional.join(" ").trim();
  return {
    ...(term === "" ? {} : { term }),
    ...(limit === undefined ? {} : { limit }),
    refresh,
    rebuild,
    json,
  };
}

export async function runGlossaryCommand(args: string[]): Promise<void> {
  const parsed = parseGlossaryArgs(args);
  await runAgentBriefCli<GlossaryBriefLike>({
    kind: "glossary",
    guard: isGlossaryBriefLike,
    json: parsed.json,
    params: {
      ...(parsed.term === undefined ? {} : { term: parsed.term }),
      ...(parsed.limit === undefined ? {} : { limit: parsed.limit }),
      ...(parsed.refresh ? { refresh: true } : {}),
      ...(parsed.rebuild ? { rebuild: true } : {}),
    },
  });
}
```

- [ ] **Step 4: Register the command**

In `packages/cli/src/index.ts`, register `glossary` alongside the other agent commands, following the existing `why` / `expert` registration exactly (import `runGlossaryCommand` and add the `case "glossary":` branch plus the `COMMAND_NAMES` entry).

- [ ] **Step 5: Run the tests**

Run: `bun test packages/cli/src/commands/glossary.test.ts`
Expected: PASS (11 tests).

Run: `bun test packages/cli/src`
Expected: PASS — this catches the `readme-cli` registry drift and any help-text assertion that enumerates commands.

- [ ] **Step 6: Commit**

```bash
git add packages/cli/src/commands/glossary.ts packages/cli/src/commands/glossary.test.ts packages/cli/src/index.ts
git commit -m "feat(glossary): nimbus glossary CLI command"
```

---

### Task 16: End-to-end scenario

**Files:**
- Test: `packages/gateway/test/e2e/scenarios/glossary.e2e.test.ts`

**Interfaces:**
- Consumes: everything above.
- Produces: nothing — this task only proves the assembled behaviour.

- [ ] **Step 1: Read a reference e2e test**

Read `packages/gateway/test/e2e/scenarios/expert.e2e.test.ts` and match its setup helpers and import style.

- [ ] **Step 2: Write the e2e test**

Create `packages/gateway/test/e2e/scenarios/glossary.e2e.test.ts`:

```typescript
import { Database } from "bun:sqlite";
import { beforeEach, expect, test } from "bun:test";

import { emitGlossaryBrief, runGlossary } from "../../../src/agents/glossary.ts";
import { runGlossaryPass } from "../../../src/glossary/glossary-extract.ts";
import { CURRENT_SCHEMA_VERSION } from "../../../src/index/local-index.ts";
import { runIndexedSchemaMigrations } from "../../../src/index/migrations/runner.ts";

/** There is no `runMigrations` export — this wrapper matches every other test in the repo. */
function runMigrations(db: Database): void {
  runIndexedSchemaMigrations(db, CURRENT_SCHEMA_VERSION);
}
import { upsertIndexedItem } from "../../../src/index/item-store.ts";

let db: Database;

const PASS = {
  maxNewTermsPerPass: 25,
  statsRecheckPerPass: 50,
  minDocFreq: 3,
  consolidateTimeoutMs: 1000,
  nowMs: 5000,
};

function seedThreads(): void {
  const texts = [
    "We adopted Change Data Record (CDR) for the sync path last quarter.",
    "The CDR envelope carries the before and after row images.",
    "Every CDR is replayed by the backfill job when a shard splits.",
  ];
  texts.forEach((t, i) => {
    upsertIndexedItem(db, {
      service: i === 2 ? "jira" : "slack",
      type: i === 2 ? "issue" : "message",
      externalId: `t${String(i)}`,
      title: t,
      bodyPreview: t,
      modifiedAt: 1000 + i,
      syncedAt: 1000 + i,
    });
  });
}

beforeEach(() => {
  db = new Database(":memory:");
  runMigrations(db);
});

test("extraction to brief: a term evidenced by 3 threads is defined with dates", async () => {
  seedThreads();
  const llm = {
    generateJson: async () =>
      JSON.stringify({
        isDomainTerm: true,
        definition: "The per-row change envelope used by the sync path.",
      }),
  };
  await runGlossaryPass(db, { ...PASS, llm });

  const brief = await runGlossary(
    { term: "CDR" },
    { db, notify: () => undefined, sessionId: "e2e" },
  );

  expect(brief.mode).toBe("term");
  const entry = brief.entries[0];
  expect(entry).toBeDefined();
  expect(entry?.docFreq).toBeGreaterThanOrEqual(3);
  expect(entry?.serviceSpread).toBeGreaterThanOrEqual(2);
  expect(entry?.firstSeenAt).toBeGreaterThan(0);
  expect(entry?.lastSeenAt).toBeGreaterThanOrEqual(entry?.firstSeenAt ?? 0);
  expect(entry?.topSources.length).toBeGreaterThan(0);
});

test("the no-argument list is frequency ranked", async () => {
  seedThreads();
  const llm = {
    generateJson: async () => JSON.stringify({ isDomainTerm: true, definition: "d" }),
  };
  await runGlossaryPass(db, { ...PASS, llm });

  const brief = await runGlossary({}, { db, notify: () => undefined, sessionId: "e2e" });
  expect(brief.mode).toBe("list");
  expect(brief.entries.length).toBeGreaterThan(0);
});

test("the briefReady notification carries markdown and typed findings", async () => {
  seedThreads();
  const llm = {
    generateJson: async () => JSON.stringify({ isDomainTerm: true, definition: "d" }),
  };
  await runGlossaryPass(db, { ...PASS, llm });

  const seen: Array<{ method: string; params: unknown }> = [];
  await emitGlossaryBrief(
    { term: "CDR" },
    { db, notify: (method, params) => seen.push({ method, params }), sessionId: "e2e" },
  );
  await Bun.sleep(50);

  const ready = seen.find((s) => s.method === "glossary.briefReady");
  expect(ready).toBeDefined();
  const p = ready?.params as { brief?: string; findings?: { kind?: string } };
  expect(typeof p.brief).toBe("string");
  expect(p.brief?.length).toBeGreaterThan(0);
  expect(p.findings?.kind).toBe("glossary");
});

test("zero HITL: the agent source imports no executor and declares no HITL", async () => {
  const src = await Bun.file("packages/gateway/src/agents/glossary.ts").text();
  expect(src).not.toContain("ToolExecutor");
  expect(src).not.toContain("HITL_REQUIRED");
});

test("zero egress: a full pass plus a brief appends no egress_ledger rows", async () => {
  seedThreads();
  const llm = {
    generateJson: async () => JSON.stringify({ isDomainTerm: true, definition: "d" }),
  };
  await runGlossaryPass(db, { ...PASS, llm });
  await runGlossary({ term: "CDR" }, { db, notify: () => undefined, sessionId: "e2e" });

  const rows = db.query("SELECT COUNT(*) AS c FROM egress_ledger").get() as { c: number };
  expect(rows.c).toBe(0);
});

test("an unknown term returns did-you-mean suggestions", async () => {
  seedThreads();
  const llm = {
    generateJson: async () => JSON.stringify({ isDomainTerm: true, definition: "d" }),
  };
  await runGlossaryPass(db, { ...PASS, llm });

  const brief = await runGlossary(
    { term: "CDC" },
    { db, notify: () => undefined, sessionId: "e2e" },
  );
  expect(brief.mode).toBe("miss");
  expect(brief.suggestions).toContain("cdr");
});
```

- [ ] **Step 3: Run the e2e test**

Run: `bun test packages/gateway/test/e2e/scenarios/glossary.e2e.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 4: Commit**

```bash
git add packages/gateway/test/e2e/scenarios/glossary.e2e.test.ts
git commit -m "test(glossary): end-to-end scenario covering extraction, brief, zero HITL and zero egress"
```

---

### Task 17: Documentation + ship-readiness

**Files:**
- Modify: `docs/CHANGELOG.md`
- Modify: `docs/roadmap.md`
- Modify: `docs/cli-reference.md`
- Modify: `docs/architecture.md`
- Modify: `docs/schema-reference.md`
- Modify: `CLAUDE.md` and `GEMINI.md` (schema version only)

**Interfaces:**
- Consumes: the shipped feature.
- Produces: no code.

- [ ] **Step 1: Add the CHANGELOG entry**

In `docs/CHANGELOG.md`, add a dated entry under the current unreleased section. This is the canonical delivery log — the record goes here, not in the `CLAUDE.md` status line:

```markdown
- **`nimbus glossary` — implicit-knowledge glossary** (2026-07-30) — a tenth built-in read-only
  agent plus a background extraction pass that mines domain terminology from the already-indexed
  graph. Deterministic candidate mining (5 families, family-5 sentence-initial guard) recomputes
  every statistic from the existing FTS index rather than accumulating counters, so passes are
  idempotent; the local LLM is called only to consolidate or veto a new term, capped at 25 calls
  per pass and running sequentially. A pure-SQL reconciliation sweep re-verifies 50 terms per pass
  so a term whose sources were deleted is demoted and unprojected rather than lingering with
  inflated statistics. Consolidated terms are projected into the unified index as
  `nimbus:glossary_term` (joining `PROSE_HEAVY_TYPES`, 22 → 23) with synonyms written into
  `body_preview` so `nimbus ask "what does Change Data Record mean?"` resolves through ordinary
  search. Schema **V45** (`glossary_term`, `glossary_pass_state`); Tauri `ALLOWED_METHODS` 101 →
  102 (I7). No new invariant, no new HTTP write route, no new connector; zero HITL actions and zero
  `egress_ledger` rows. `[glossary]` defaults ON. Spec:
  `docs/superpowers/specs/2026-07-30-nimbus-glossary-design.md`; plan:
  `docs/superpowers/plans/2026-07-30-nimbus-glossary.md`.
```

- [ ] **Step 2: Check off the roadmap rows**

In `docs/roadmap.md`:
- In the S1 "Remaining" bullet (~line 913), note that `glossary` shipped and leave `decisions` (+ `pre-mortem`, `negotiate`) outstanding.
- Move a `**nimbus glossary`** entry into the S1 "Delivered so far" list with the 2026-07-30 date.
- Tick the Wave 5 `nimbus glossary [<term>]` checkbox (~line 1071).
- Tick the Wave 5 acceptance criterion (~line 1105).

- [ ] **Step 3: Document the CLI**

In `docs/cli-reference.md`, add a `nimbus glossary` section documenting `[<term>]`, `--limit`, `--refresh`, `--rebuild`, `--json`, and the exit codes (1 = gateway not running, 2 = agent error).

- [ ] **Step 4: Update the architecture and schema docs**

In `docs/architecture.md`, add the V45 row to the schema reference and `agents.glossary` to the IPC method catalogue.

In `docs/schema-reference.md`, document both new tables the way V44's `egress_ledger` is documented — read that entry first and match its depth and formatting. Cover every column of `glossary_term` and `glossary_pass_state`, including why `first_seen_at`/`last_seen_at` are content dates rather than row timestamps, and what `attempts`/`last_attempt_at` and `stats_verified_at` are for.

In `CLAUDE.md` and `GEMINI.md`, change `schema V44` to `schema V45` in the status line. **Do not** add the delivery narrative there — that belongs in the CHANGELOG.

- [ ] **Step 5: Run the full pre-flight**

Run: `bun run preflight`
Expected: PASS. Investigate any failure before proceeding — do not push red.

- [ ] **Step 6: Run biome the worktree-safe way**

Run: `bunx biome check packages scripts`
Expected: PASS.

Do **not** use `bun run lint` — it reports 0 files inside `.claude/worktrees/` and gives a false pass.

- [ ] **Step 7: Run the static invariant audit**

Run: `bun run audit:invariants`
Expected: PASS — confirms I14/D12 over the new `glossary/` writes.

- [ ] **Step 8: Run the CI-Linux-authoritative coverage floor**

Run: `bun run audit:coverage-floor:build-lcov`
Then: `bun run audit:coverage-floor`
Expected: PASS with every new file ≥80% line and branch.

If the CLI shard reports 0 entries, `rm -rf coverage` and rebuild. Native-Windows coverage false positives on `update.ts` / `socket-listeners.ts` are pre-existing — ignore those two.

- [ ] **Step 9: Check links on the changed docs**

Run the repository's lychee gate over the whole branch, not just edited files — a pre-existing broken link elsewhere still fails your PR.

- [ ] **Step 10: Review the whole branch**

Run: `git diff main...HEAD --stat`
Read every changed file once more. Confirm: no `any`, no raw `db.run`, no `mock.module` in CLI tests, no hardcoded path separators, and the agent still imports no executor.

- [ ] **Step 11: Commit and push**

```bash
git add docs/ CLAUDE.md GEMINI.md
git commit -m "docs(glossary): changelog, roadmap, CLI reference and schema V45"
git push -u origin dev/asafgolombek/nimbus-glossary
```

- [ ] **Step 12: Open the PR**

Title (release-please parses this): `feat(glossary): nimbus glossary — implicit-knowledge terminology agent`

The description becomes the permanent commit body, so put the reasoning there: what shipped, the V45 schema, the I7 count change, the invariant analysis (no new invariant), and links to the spec and plan. Do **not** include a bare `Release-As:` trailer.

---

## Self-Review

**Spec coverage.** Every spec section maps to a task: §3 module layout → Tasks 2–12; §4 schema → Task 1; §5.1 FTS recompute → Task 7; §5.2 two-phase sequence → Task 11; §5.3 families/scoring/stopwords → Tasks 2, 4, 5; §5.4 consolidation → Task 9; §5.5 reconciliation → Task 10; §5.6 execution discipline → Tasks 9 (timeout) and 11 (sequential, abort); §5.7 no-LLM degradation → Tasks 9 and 11; §6 projection → Task 8; §7 trigger/config → Task 12; §8 agent → Task 13; §9 IPC/CLI → Tasks 14–15; §10 testing → every task plus Task 16; §11 invariants → Tasks 7, 9, 13, 14, 17; §13 delivery → Task 17; §14 acceptance → Task 16.

**Deferred by design (spec §12), with no task:** manual term authoring via `[glossary.terms]`. Named in the spec as an additive follow-up.

**Known deviations from the spec, deliberate:**
- The V45 table adds a `form` column not listed in spec §4. The reconciliation sweep re-scores a term and needs its mining family; re-deriving it from the surface string would duplicate mining logic in a second place.
- The V45 table also adds `attempts` / `last_attempt_at`, and `[glossary]` gains `retry_base_cooldown_ms` + `stats_recheck_cooldown_ms`. Added during plan review to close a queue-starvation defect and to stop the reconciliation sweep re-running on every sync; see the plan-review response. The spec's §5.2 and §5.5 descriptions remain accurate — these bound *when* work is retried, not what the pass does.
- The scheduler-triggered pass in Task 12 runs without an LLM, so unattended passes produce snippet-sourced definitions until an LLM-backed path is wired. This is the documented §5.7 degradation, and the upgrade path (re-queue on next pass) is already specified.

**Type consistency check.** `GlossaryTerm` (domain, camelCase, `glossary/glossary-types.ts`) is distinct from `GlossaryEntry` (brief-facing, `agents/_lib/glossary-types.ts`) — deliberate, and the two files are never cross-imported except through `agents/glossary.ts`. `ConsolidatorLlm.generateJson` (Task 9) is distinct from `SynthesizerLlm.generateMarkdown` (existing) — different contracts, correctly not merged. `CandidateForm` is used identically in Tasks 4, 5, 7 and 10. `unprojectTerm` is called from Tasks 10 and 11 with the same `(db, termKey)` signature defined in Task 8.
