# Nimbus Glossary — Manual Term Authoring Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a human author and correct glossary terms in `nimbus.toml`, with config as desired state for authored rows only.

**Architecture:** A pre-pass at the head of `runGlossaryPass` reads `[glossary.terms]` / `[glossary.synonyms]`, writes rows straight to `status='consolidated'` with `definition_source='manual'` (no model call), and demotes authored rows whose config entry disappeared. Mining and the reconciliation sweep gain narrow guards so they refresh an authored row's statistics without ever overwriting its definition, display form, or status. A V46 migration rebuilds `glossary_term` to widen the `definition_source` CHECK.

**Tech Stack:** Bun v1.2+, TypeScript 6.x strict, `bun:sqlite`, Biome, `bun:test`.

**Spec:** [`docs/superpowers/specs/2026-07-31-nimbus-glossary-manual-authoring-design.md`](../specs/2026-07-31-nimbus-glossary-manual-authoring-design.md)
**Review folded in:** [`…-design-review.md`](../specs/2026-07-31-nimbus-glossary-manual-authoring-design-review.md)

## Global Constraints

- **No `any`.** Use `unknown` for external data. TypeScript strict mode is non-negotiable.
- **All SQLite writes go through `dbRun` / `dbExec` / `dbStmtRun`** from `db/write.ts` (invariant I14, static check D12). A bare `db.run(...)` in `src/` fails the preflight static audit. `db.query(...).get()/.all()` for reads is fine.
- **No new security invariant.** This feature adds no HITL action, no egress, no HTTP route, no Tauri-exposed method, no Vault key.
- **Migrations are append-only and forward-only.** Never edit `glossary-v45-sql.ts` — it shipped in `v1.13.0`.
- **Cross-platform paths:** `path.join()` / `os.tmpdir()`, never hardcoded separators.
- **Branch:** work happens on `dev/asafgolombek/glossary-manual-authoring` in the worktree at `.claude/worktrees/glossary-manual-authoring`. Never commit on `main`.
- **Lint in this worktree is a trap.** `bun run lint` reports "Checked 0 files" and exits 0; `bun run lint:markdown` checks nothing and exits 0. Use `bunx biome check packages scripts` and `bunx markdownlint-cli2 "<explicit-path>"`.
- **Verify every gate with an explicit exit code.** A pipe returns the last command's status: run `cmd > /tmp/out.txt 2>&1; echo "EXIT=$?"`.
- **Commit messages:** use `git commit -F -` with a quoted heredoc. Backticks inside `git commit -m "..."` are command-substituted away silently.
- **Red-prove every new test:** break the code, confirm it fails *for the intended reason*, restore, confirm green. A mutation that reddens everything, or that hangs instead of asserting, proves nothing.

---

## File Structure

**Created:**

| File | Responsibility |
| --- | --- |
| `packages/gateway/src/index/glossary-manual-v46-sql.ts` | V46 table-rebuild SQL |
| `packages/gateway/src/index/migrations/runner-v46.test.ts` | V46 migration test |
| `packages/gateway/src/config/nimbus-toml-glossary-terms.ts` | `[glossary.terms]` / `[glossary.synonyms]` parser + loader with the `loaded` flag |
| `packages/gateway/src/config/nimbus-toml-glossary-terms.test.ts` | parser tests |
| `packages/gateway/src/config/toml-primitives.test.ts` | table-driven primitive tests (none exist today) |
| `packages/gateway/src/glossary/glossary-manual.ts` | the pre-pass: upsert authored rows, demote removed ones |
| `packages/gateway/src/glossary/glossary-manual.test.ts` | pre-pass tests |

**Modified:**

| File | Change |
| --- | --- |
| `packages/gateway/src/config/toml-primitives.ts` | quote-aware `stripComment`, `\"` unescape, `hasUnterminatedString` |
| `packages/gateway/src/config/filesystem-toml.ts` | drop private `stripComment`/`parseString`, import shared |
| `packages/gateway/src/index/migrations/runner.ts` | register the V46 step |
| `packages/gateway/src/index/local-index.ts:265` | `CURRENT_SCHEMA_VERSION` 45 → 46 |
| `packages/gateway/src/glossary/glossary-types.ts:17` | `DefinitionSource` gains `"manual"` |
| `packages/gateway/src/agents/_lib/glossary-types.ts:20` | duplicated union gains `"manual"` |
| `packages/gateway/src/glossary/glossary-store.ts` | `display_term` guard, manual-first ordering, `countByStatus.manual`, `upsertManualTerm` |
| `packages/gateway/src/glossary/glossary-reconcile.ts` | never demote a manual row |
| `packages/gateway/src/glossary/glossary-extract.ts` | call the pre-pass; wrap rebuild in one transaction |
| `packages/gateway/src/platform/assemble.ts` | thread `configDir` into pass options |
| `packages/gateway/src/agents/_lib/render.ts:295` | `manual` label branch |
| `packages/cli/src/commands/glossary.ts` | corrected rebuild preview, skipped-entry reporting |

---

## Task 1: Repair the shared TOML primitives

**Files:**

- Modify: `packages/gateway/src/config/toml-primitives.ts`
- Create: `packages/gateway/src/config/toml-primitives.test.ts`

**Interfaces:**

- Produces: `stripComment(line: string): string` (unchanged signature, quote-aware),
  `parseString(raw: string): string` (unchanged signature, `\"` unescape),
  `hasUnterminatedString(line: string): boolean` (new export).

**Background you need.** `nimbus.toml` is parsed by this hand-rolled line parser, not a TOML library. Two shipped bugs matter once a config value carries prose: `stripComment` truncates at the first `#` even inside a quoted string, and `parseString` unescapes `\\"` where TOML writes `\"`. Both fail silently.

**The trailing-backslash subtlety — read before writing code.** A naive quote-scanner treats `\` as escaping the next character, which is right for `"he said \"hi\""`. But it breaks `path = "C:\dev\"`: the final `\` escapes the closing quote, so the scan ends *inside* a string and the line looks malformed. That form is not strictly valid TOML — real TOML needs `"C:\\dev\\"` — but this parser has always accepted it, and `[[filesystem.roots]]` (a Windows directory surface, see Task 2) is exactly where it appears. Silently dropping a filesystem root would silently drop a whole indexed tree.

So the scanner runs **twice**: once treating `\` as an escape, and if that ends inside a string, once treating `\` as a literal character. A line is malformed only when *both* passes end inside a string. This preserves escaped quotes and trailing-backslash paths, and still fail-closes on a genuinely unterminated string.

- [ ] **Step 1: Write the failing test**

Create `packages/gateway/src/config/toml-primitives.test.ts`:

```ts
import { expect, test } from "bun:test";

import {
  hasUnterminatedString,
  parseString,
  splitKeyValue,
  stripComment,
} from "./toml-primitives.ts";

/** End-to-end through the three primitives, the way `forEachSectionEntry` uses them. */
function valueOf(line: string): string | undefined {
  const kv = splitKeyValue(stripComment(line).trim());
  return kv === undefined ? undefined : parseString(kv.valRaw);
}

test("a # inside a quoted value is content, not a comment", () => {
  expect(valueOf('sprint = "Tracks the # of open PRs each week."')).toBe(
    "Tracks the # of open PRs each week.",
  );
});

test("a # outside quotes still starts a comment", () => {
  expect(valueOf('a = "x" # trailing comment')).toBe("x");
});

test("a value that is only a hash survives", () => {
  expect(valueOf('a = "#"')).toBe("#");
});

test("a # in the key position still comments the line out", () => {
  expect(stripComment('a# = "x"')).toBe("a");
});

test("a value with no hash is unchanged", () => {
  expect(valueOf('a = "no hash here"')).toBe("no hash here");
});

test("an escaped quote unescapes to a bare quote", () => {
  expect(valueOf(String.raw`a = "The team calls it the \"waist\"."`)).toBe(
    'The team calls it the "waist".',
  );
});

test("a Windows path round-trips byte-identical", () => {
  // Regression guard for spec §3.3: this fails the moment someone "completes"
  // parseString into a full escape decoder. \n and \t must stay literal.
  const line = String.raw`piper_path = "C:\tools\new\table.onnx"`;
  expect(valueOf(line)).toBe(String.raw`C:\tools\new\table.onnx`);
});

test("a Windows path ending in a backslash is still accepted", () => {
  const line = String.raw`path = "C:\dev\"`;
  expect(hasUnterminatedString(line)).toBe(false);
  expect(valueOf(line)).toBe(String.raw`C:\dev\`);
});

test("a genuinely unterminated string is reported", () => {
  expect(hasUnterminatedString('a = "oops # x')).toBe(true);
});

test("a well-formed line is not reported as unterminated", () => {
  expect(hasUnterminatedString('a = "fine"')).toBe(false);
  expect(hasUnterminatedString(String.raw`a = "he said \"hi\""`)).toBe(false);
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
bun test packages/gateway/src/config/toml-primitives.test.ts > /tmp/t1.txt 2>&1; echo "EXIT=$?"; tail -30 /tmp/t1.txt
```

Expected: FAIL. `hasUnterminatedString` is not exported (import error), and the `#`-inside-quotes and escaped-quote cases fail on the shipped implementation.

- [ ] **Step 3: Implement the repair**

In `packages/gateway/src/config/toml-primitives.ts`, replace the existing `stripComment` and `parseString` with:

```ts
type LineScan = { text: string; unterminated: boolean };

/**
 * One left-to-right pass. `escapes` decides whether a backslash inside a
 * string consumes the next character.
 *
 * Both modes exist because neither alone is correct for every value this
 * parser has always accepted. With escapes on, `"he said \"hi\""` scans
 * correctly but `"C:\dev\"` looks unterminated. With escapes off, the reverse.
 * `scanLine` is called twice (see `stripComment`) so both survive.
 */
function scanLine(line: string, escapes: boolean): LineScan {
  let inString = false;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (escapes && inString && ch === "\\") {
      i += 1;
      continue;
    }
    if (ch === '"') {
      inString = !inString;
      continue;
    }
    if (ch === "#" && !inString) {
      return { text: line.slice(0, i), unterminated: false };
    }
  }
  return { text: line, unterminated: inString };
}

/**
 * Strips a trailing `#` comment, ignoring `#` inside a double-quoted value.
 *
 * The escape-aware pass runs first; if it ends inside a string the line is
 * re-scanned with backslash as a literal, which is what rescues a Windows
 * path written as `"C:\dev\"`. A line malformed under BOTH passes is returned
 * with its comment left intact — callers detect it via `hasUnterminatedString`
 * and skip the entry rather than acting on a truncated value.
 */
export function stripComment(line: string): string {
  const withEscapes = scanLine(line, true);
  if (!withEscapes.unterminated) return withEscapes.text;
  const literal = scanLine(line, false);
  return literal.unterminated ? line : literal.text;
}

/** True when the line's double-quoted string never closes under either scan. */
export function hasUnterminatedString(line: string): boolean {
  return scanLine(line, true).unterminated && scanLine(line, false).unterminated;
}

/**
 * Unquotes a double-quoted value and unescapes `\"` — and DELIBERATELY nothing
 * else.
 *
 * This is not an incomplete TOML decoder waiting to be finished. The same
 * function parses path-valued keys (`piper_path`, `llamacpp_server_path`,
 * `whisper_path`, `classifier_model`, …), so teaching it `\n` / `\t` / `\\`
 * would read `C:\tools\new\table.onnx` as `C:` TAB `ools` NEWLINE `ew` TAB
 * `able.onnx` and break every Windows install pointing at a local binary.
 * `\"` is safe because no plausible path contains it. See spec §3.3.
 */
export function parseString(raw: string): string {
  const t = raw.trim();
  if (t.startsWith('"') && t.endsWith('"') && t.length >= 2) {
    return t.slice(1, -1).replaceAll('\\"', '"');
  }
  return t;
}
```

Then make `forEachSectionEntry` in `packages/gateway/src/config/nimbus-toml.ts` skip malformed lines. Add the import and one guard:

```ts
import {
  hasUnterminatedString,
  isTableHeader,
  parseIntDec,
  parseString,
  parseStringArray,
  splitKeyValue,
  stripComment,
} from "./toml-primitives.ts";
```

and inside the loop, immediately after `const trimmed = stripComment(line).trim();`:

```ts
    // A line whose quoted value never closes is malformed. Skipping beats
    // acting on the mangled value the old parser produced (a leading `"` plus
    // a truncated fragment) — no value is better than a wrong one.
    if (hasUnterminatedString(line)) {
      continue;
    }
```

- [ ] **Step 4: Run the test to verify it passes**

```bash
bun test packages/gateway/src/config/toml-primitives.test.ts > /tmp/t1.txt 2>&1; echo "EXIT=$?"; tail -20 /tmp/t1.txt
```

Expected: `EXIT=0`, 10 pass.

- [ ] **Step 5: Run the whole config suite — this is the blast-radius check**

```bash
bun test packages/gateway/src/config > /tmp/t1cfg.txt 2>&1; echo "EXIT=$?"; tail -30 /tmp/t1cfg.txt
```

Expected: `EXIT=0`. If a test fails asserting the old truncating behaviour, that test encodes the bug — correct it and say so in the commit body. Do not revert the fix.

- [ ] **Step 6: Red-prove the two headline cases**

Temporarily change `if (ch === "#" && !inString)` to `if (ch === "#")`. Re-run Step 4 — expect the `#`-inside-quotes test to fail *on its assertion* (`Expected: "Tracks the # of open PRs each week." Received: "Tracks the`), not on a throw. Restore, re-run, confirm green.

Then temporarily change `replaceAll('\\"', '"')` back to `replaceAll(String.raw`\\"`, '"')`. Re-run — expect only the escaped-quote test to fail. Restore, confirm green.

- [ ] **Step 7: Commit**

```bash
git add packages/gateway/src/config/toml-primitives.ts \
        packages/gateway/src/config/toml-primitives.test.ts \
        packages/gateway/src/config/nimbus-toml.ts
git commit -F - <<'MSG'
fix(config): stop the TOML line parser corrupting quoted values

stripComment truncated at the first `#` anywhere, including inside a
quoted string, and because the closing quote went with it parseString
then returned the fragment with its leading quote attached. parseString
also unescaped `\\"` where TOML writes `\"`. Both failed silently.

The scanner runs twice — escape-aware, then backslash-literal — so
`"he said \"hi\""` and `"C:\dev\"` both survive; only a string
unterminated under both scans is malformed, and forEachSectionEntry now
skips that line instead of acting on a mangled value.

parseString gains `\"` and deliberately nothing else: the same function
parses piper_path / llamacpp_server_path / whisper_path, so a full escape
decoder would read C:\tools\new\table.onnx as C: TAB ools NEWLINE ew TAB
able.onnx.
MSG
```

---

## Task 2: Deduplicate `filesystem-toml.ts` onto the shared primitives

**Files:**

- Modify: `packages/gateway/src/config/filesystem-toml.ts` (delete the private `stripComment` at ~line 36 and `parseString` at ~line 39; import the shared ones)
- Modify: `packages/gateway/src/config/filesystem-toml.test.ts` (add one test)

**Interfaces:**

- Consumes: `stripComment`, `parseString` from Task 1.
- Produces: nothing new.

**Why this is in scope.** `filesystem-toml.ts` carries byte-identical private copies of both broken helpers. `[[filesystem.roots]]` is a path surface where a directory named `#inbox` is ordinary, so the truncation bug is arguably more reachable there than in the glossary. Repairing only the shared copy would leave a known-identical bug live in a sibling file edited in the same breath.

- [ ] **Step 1: Write the failing test**

Append to `packages/gateway/src/config/filesystem-toml.test.ts`:

```ts
test("a root path containing # is not truncated", () => {
  const raw = ["[[filesystem.roots]]", 'path = "/home/me/notes/#inbox"'].join("\n");
  const roots = parseNimbusFilesystemToml(raw);
  expect(roots).toHaveLength(1);
  expect(roots[0]?.path).toBe("/home/me/notes/#inbox");
});
```

Check the existing imports at the top of that file and add `parseNimbusFilesystemToml` if it is not already imported. If the exported parser has a different name, use the name the file already exports — do not rename it.

- [ ] **Step 2: Run the test to verify it fails**

```bash
bun test packages/gateway/src/config/filesystem-toml.test.ts > /tmp/t2.txt 2>&1; echo "EXIT=$?"; tail -20 /tmp/t2.txt
```

Expected: FAIL — the path comes back as `/home/me/notes/` because the private `stripComment` truncated it.

- [ ] **Step 3: Delete the private copies and import the shared ones**

In `packages/gateway/src/config/filesystem-toml.ts`, delete both private function declarations:

```ts
function stripComment(line: string): string {
  const hash = line.indexOf("#");
  if (hash < 0) {
    return line;
  }
  return line.slice(0, hash);
}
```

```ts
function parseString(raw: string): string {
  const t = raw.trim();
  if (t.startsWith('"') && t.endsWith('"') && t.length >= 2) {
    return t.slice(1, -1).replaceAll(String.raw`\\"`, '"');
  }
  return t;
}
```

and add to the import block at the top:

```ts
import { parseString, stripComment } from "./toml-primitives.ts";
```

Leave every other function in the file alone — the array-of-tables handling is unrelated.

- [ ] **Step 4: Run the tests to verify they pass**

```bash
bun test packages/gateway/src/config/filesystem-toml.test.ts > /tmp/t2.txt 2>&1; echo "EXIT=$?"; tail -20 /tmp/t2.txt
```

Expected: `EXIT=0`, all pass including the new one.

- [ ] **Step 5: Typecheck (the deletion could orphan an import)**

```bash
bunx tsc --noEmit -p packages/gateway/tsconfig.json > /tmp/t2tsc.txt 2>&1; echo "EXIT=$?"; tail -20 /tmp/t2tsc.txt
```

Expected: `EXIT=0`. Note this covers `src/**/*` only — it is not evidence about any test tree.

- [ ] **Step 6: Commit**

```bash
git add packages/gateway/src/config/filesystem-toml.ts \
        packages/gateway/src/config/filesystem-toml.test.ts
git commit -F - <<'MSG'
fix(config): filesystem roots inherit the TOML primitive repair

filesystem-toml.ts carried byte-identical private copies of stripComment
and parseString, so the previous commit left both bugs live on a path
surface where a `#inbox` directory is ordinary — a truncated root path
silently drops a whole indexed tree.

Drops the copies for the shared imports rather than fixing the same bug
twice, which also removes the drift source that produced two copies.
MSG
```

---

## Task 3: V46 migration and the widened `DefinitionSource`

**Files:**

- Create: `packages/gateway/src/index/glossary-manual-v46-sql.ts`
- Create: `packages/gateway/src/index/migrations/runner-v46.test.ts`
- Modify: `packages/gateway/src/index/migrations/runner.ts` (import + one step)
- Modify: `packages/gateway/src/index/local-index.ts:265`
- Modify: `packages/gateway/src/glossary/glossary-types.ts:17`
- Modify: `packages/gateway/src/agents/_lib/glossary-types.ts:20`

**Interfaces:**

- Produces: `GLOSSARY_MANUAL_V46_SQL: readonly string[]`; `DefinitionSource = "llm" | "snippet" | "manual"`.

**Background.** `glossary_term.definition_source` carries `CHECK(definition_source IN ('llm','snippet'))`. SQLite cannot alter a CHECK in place, and V45 shipped in `v1.13.0`, so the table must be rebuilt in a new step. `applySchemaStep` already wraps each step in a transaction and accepts a SQL array.

Both `DefinitionSource` unions widen **in this task**, not later: `toEntry` in `agents/glossary.ts` assigns the store's `definitionSource` into the `agents/_lib` union, so widening one without the other breaks `tsc`.

- [ ] **Step 1: Write the failing test**

Create `packages/gateway/src/index/migrations/runner-v46.test.ts`:

```ts
import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";

import { CURRENT_SCHEMA_VERSION } from "../local-index.ts";
import { runIndexedSchemaMigrations } from "./runner.ts";

function runMigrations(db: Database): void {
  runIndexedSchemaMigrations(db, CURRENT_SCHEMA_VERSION);
}

function seedRow(db: Database, key: string, source: string): void {
  db.run(
    `INSERT INTO glossary_term
       (term_key, display_term, status, definition, definition_source,
        doc_freq, first_seen_at, last_seen_at, updated_at)
     VALUES (?, ?, 'consolidated', 'd', ?, 3, 1, 2, 3)`,
    [key, key.toUpperCase(), source],
  );
}

test("V46 accepts definition_source='manual'", () => {
  const db = new Database(":memory:");
  runMigrations(db);
  expect(() => {
    seedRow(db, "cdr", "manual");
  }).not.toThrow();
  db.close();
});

test("V46 still rejects an unknown definition_source", () => {
  const db = new Database(":memory:");
  runMigrations(db);
  expect(() => {
    seedRow(db, "cdr", "bogus");
  }).toThrow();
  db.close();
});

test("V46 preserves pre-existing rows through the table rebuild", () => {
  const db = new Database(":memory:");
  runIndexedSchemaMigrations(db, 45);
  seedRow(db, "kept", "llm");
  runMigrations(db);
  const row = db
    .query("SELECT display_term, definition_source, doc_freq FROM glossary_term WHERE term_key = ?")
    .get("kept") as { display_term: string; definition_source: string; doc_freq: number } | null;
  expect(row).toEqual({ display_term: "KEPT", definition_source: "llm", doc_freq: 3 });
  db.close();
});

test("V46 recreates every index dropped with the old table", () => {
  const db = new Database(":memory:");
  runMigrations(db);
  const names = (
    db
      .query("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='glossary_term'")
      .all() as Array<{ name: string }>
  ).map((r) => r.name);
  for (const idx of [
    "idx_glossary_term_status_score",
    "idx_glossary_term_pending_attempt",
    "idx_glossary_term_display",
    "idx_glossary_term_verified",
  ]) {
    expect(names).toContain(idx);
  }
  db.close();
});

test("V46 is idempotent across a second migration run", () => {
  const db = new Database(":memory:");
  runMigrations(db);
  runMigrations(db);
  seedRow(db, "cdr", "manual");
  expect(
    (db.query("SELECT COUNT(*) AS n FROM glossary_term").get() as { n: number }).n,
  ).toBe(1);
  db.close();
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
bun test packages/gateway/src/index/migrations/runner-v46.test.ts > /tmp/t3.txt 2>&1; echo "EXIT=$?"; tail -30 /tmp/t3.txt
```

Expected: FAIL — the `manual` insert throws on the V45 CHECK.

- [ ] **Step 3: Write the migration SQL**

Create `packages/gateway/src/index/glossary-manual-v46-sql.ts`:

```ts
/**
 * V46 — widen `glossary_term.definition_source` to allow `'manual'`.
 *
 * SQLite cannot alter a CHECK constraint in place, so the table is rebuilt.
 * V45 shipped in v1.13.0, so editing `glossary-v45-sql.ts` is not available:
 * a fresh database runs V45 and then immediately rebuilds it here. Slightly
 * wasteful on an empty table, and correct.
 *
 * Columns are named explicitly rather than `INSERT … SELECT *`. The orders
 * match today, but a positional copy would silently misalign if V45's column
 * list were ever reordered — and a misaligned copy of a definition into a
 * score column is exactly the kind of corruption a migration must not risk.
 *
 * `DROP TABLE` drops the table's indexes with it, which is why all four are
 * recreated after the rename. No foreign key references `glossary_term` in
 * either direction, so the rebuild has no cascade.
 */
export const GLOSSARY_MANUAL_V46_SQL: readonly string[] = [
  `CREATE TABLE IF NOT EXISTS glossary_term_v46 (
     term_key          TEXT PRIMARY KEY,
     display_term      TEXT NOT NULL,
     status            TEXT NOT NULL CHECK(status IN ('pending','consolidated','vetoed')),
     definition        TEXT,
     definition_source TEXT CHECK(definition_source IN ('llm','snippet','manual')),
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
   )`,
  `INSERT INTO glossary_term_v46 (
     term_key, display_term, status, definition, definition_source, doc_freq,
     service_spread, score, form, first_seen_at, last_seen_at, top_sources,
     synonyms, near_misses, consolidated_at, stats_verified_at, attempts,
     last_attempt_at, updated_at
   )
   SELECT
     term_key, display_term, status, definition, definition_source, doc_freq,
     service_spread, score, form, first_seen_at, last_seen_at, top_sources,
     synonyms, near_misses, consolidated_at, stats_verified_at, attempts,
     last_attempt_at, updated_at
   FROM glossary_term`,
  "DROP TABLE glossary_term",
  "ALTER TABLE glossary_term_v46 RENAME TO glossary_term",
  `CREATE INDEX IF NOT EXISTS idx_glossary_term_status_score
     ON glossary_term(status, score DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_glossary_term_pending_attempt
     ON glossary_term(status, last_attempt_at)`,
  `CREATE INDEX IF NOT EXISTS idx_glossary_term_display
     ON glossary_term(display_term)`,
  `CREATE INDEX IF NOT EXISTS idx_glossary_term_verified
     ON glossary_term(status, stats_verified_at)`,
];
```

- [ ] **Step 4: Register the step and bump the version**

In `packages/gateway/src/index/migrations/runner.ts`, add the import beside the existing V45 one (imports are alphabetical — `glossary-manual-v46-sql.ts` sorts before `glossary-v45-sql.ts`):

```ts
import { GLOSSARY_MANUAL_V46_SQL } from "../glossary-manual-v46-sql.ts";
```

and append to `INDEXED_SCHEMA_STEPS`, immediately after the V45 entry:

```ts
  simpleStep(
    45,
    46,
    "glossary_term.definition_source allows 'manual' (v46)",
    GLOSSARY_MANUAL_V46_SQL,
  ),
```

In `packages/gateway/src/index/local-index.ts:265`:

```ts
export const CURRENT_SCHEMA_VERSION = 46;
```

- [ ] **Step 5: Widen both `DefinitionSource` unions**

`packages/gateway/src/glossary/glossary-types.ts:17`:

```ts
/** `manual` rows are authored in `[glossary.terms]`; see spec §4. */
export type DefinitionSource = "llm" | "snippet" | "manual";
```

`packages/gateway/src/agents/_lib/glossary-types.ts:20` — this union is duplicated rather than imported, so it must change too or `toEntry` fails to compile:

```ts
  definitionSource: "llm" | "snippet" | "manual" | null;
```

- [ ] **Step 6: Run the tests to verify they pass**

```bash
bun test packages/gateway/src/index/migrations/ > /tmp/t3.txt 2>&1; echo "EXIT=$?"; tail -20 /tmp/t3.txt
bunx tsc --noEmit -p packages/gateway/tsconfig.json > /tmp/t3tsc.txt 2>&1; echo "TSC EXIT=$?"; tail -20 /tmp/t3tsc.txt
```

Expected: both `EXIT=0`. Other migration tests assert `CURRENT_SCHEMA_VERSION` reaches the newest table — if one hardcodes `45`, update it.

- [ ] **Step 7: Red-prove the rebuild-preservation test**

Temporarily replace the explicit column list in the `INSERT` with `INSERT INTO glossary_term_v46 SELECT * FROM glossary_term` — it should still pass (the orders match today), which proves that test does *not* cover misalignment. Now temporarily swap two column names in the `SELECT` list (`display_term, status` → `status, display_term`) and confirm the preservation test fails on its assertion. Restore.

- [ ] **Step 8: Commit**

```bash
git add packages/gateway/src/index/glossary-manual-v46-sql.ts \
        packages/gateway/src/index/migrations/runner-v46.test.ts \
        packages/gateway/src/index/migrations/runner.ts \
        packages/gateway/src/index/local-index.ts \
        packages/gateway/src/glossary/glossary-types.ts \
        packages/gateway/src/agents/_lib/glossary-types.ts
git commit -F - <<'MSG'
feat(db): V46 widens glossary_term.definition_source to allow 'manual'

SQLite cannot alter a CHECK in place and V45 shipped in v1.13.0, so the
table is rebuilt rather than edited. Columns are copied by name, not by
position, so a future reordering of V45 cannot silently misalign them.

Both DefinitionSource unions widen together — agents/_lib/glossary-types
duplicates the literal union rather than importing it, so widening one
alone fails to compile.
MSG
```

---

## Task 4: Parse `[glossary.terms]` and `[glossary.synonyms]`

**Files:**

- Create: `packages/gateway/src/config/nimbus-toml-glossary-terms.ts`
- Create: `packages/gateway/src/config/nimbus-toml-glossary-terms.test.ts`

**Interfaces:**

- Consumes: `stripComment`, `parseString`, `splitKeyValue`, `isTableHeader`, `hasUnterminatedString` (Task 1); `normalizeTerm` from `../glossary/term-normalize.ts`.
- Produces:

```ts
export type ManualTerm = { termKey: string; displayTerm: string; definition: string };
export type ManualSkip = { entry: string; reason: string };
export type GlossaryManualConfig =
  | { loaded: false }
  | { loaded: true; terms: ManualTerm[]; synonyms: Map<string, string>; skipped: ManualSkip[] };
export function parseGlossaryManualToml(raw: string): GlossaryManualConfig;
export function loadGlossaryManualFromConfigDir(configDir: string): GlossaryManualConfig;
```

**Why a new file rather than `nimbus-toml.ts`.** The spec says the block is read from `nimbus.toml`, and it is — but `nimbus-toml.ts` is already ~1600 lines, and this parser needs its own iteration loop (it collects per-entry skip reasons, which `forEachSectionEntry` deliberately discards). A separate module keeps both focused.

**The `loaded` flag is the load-bearing detail.** `loadTomlSection` catches every error and returns defaults, so "parsed to zero authored terms" and "could not read the file" arrive identically. Under the desired-state semantics of Task 5 the second would read as *the user deleted every term*. This loader therefore does **not** use `loadTomlSection`.

- [ ] **Step 1: Write the failing test**

Create `packages/gateway/src/config/nimbus-toml-glossary-terms.test.ts`:

```ts
import { expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  type GlossaryManualConfig,
  loadGlossaryManualFromConfigDir,
  parseGlossaryManualToml,
} from "./nimbus-toml-glossary-terms.ts";

function loadedOrThrow(cfg: GlossaryManualConfig) {
  if (!cfg.loaded) throw new Error("expected a loaded config");
  return cfg;
}

test("an absent section parses to loaded-but-empty", () => {
  const cfg = loadedOrThrow(parseGlossaryManualToml("[glossary]\nenabled = true"));
  expect(cfg.terms).toEqual([]);
  expect(cfg.synonyms.size).toBe(0);
});

test("parses terms, normalizing the key and keeping the authored display form", () => {
  const raw = ['[glossary.terms]', 'CDR = "Our append-only audit row."'].join("\n");
  const cfg = loadedOrThrow(parseGlossaryManualToml(raw));
  expect(cfg.terms).toEqual([
    { termKey: "cdr", displayTerm: "CDR", definition: "Our append-only audit row." },
  ]);
});

test("a quoted key carrying spaces or dots parses", () => {
  const raw = ['[glossary.terms]', '"node.js" = "Pinned to the Bun-compatible LTS line."'].join(
    "\n",
  );
  const cfg = loadedOrThrow(parseGlossaryManualToml(raw));
  expect(cfg.terms[0]?.termKey).toBe("node.js");
  expect(cfg.terms[0]?.displayTerm).toBe("node.js");
});

test("a definition containing a hash survives", () => {
  const raw = ['[glossary.terms]', 'CDR = "Tracks the # of writes."'].join("\n");
  const cfg = loadedOrThrow(parseGlossaryManualToml(raw));
  expect(cfg.terms[0]?.definition).toBe("Tracks the # of writes.");
});

test("an alias resolves to its authored term", () => {
  const raw = [
    "[glossary.terms]",
    'CDR = "Our append-only audit row."',
    "[glossary.synonyms]",
    '"change data record" = "CDR"',
  ].join("\n");
  const cfg = loadedOrThrow(parseGlossaryManualToml(raw));
  expect(cfg.synonyms.get("change data record")).toBe("cdr");
});

test("an empty definition is skipped with a reason", () => {
  const raw = ["[glossary.terms]", 'CDR = ""'].join("\n");
  const cfg = loadedOrThrow(parseGlossaryManualToml(raw));
  expect(cfg.terms).toEqual([]);
  expect(cfg.skipped).toHaveLength(1);
  expect(cfg.skipped[0]?.entry).toBe("CDR");
  expect(cfg.skipped[0]?.reason).toContain("empty definition");
});

test("an alias with no authored target is skipped with a reason", () => {
  const raw = ["[glossary.synonyms]", '"change data record" = "CDR"'].join("\n");
  const cfg = loadedOrThrow(parseGlossaryManualToml(raw));
  expect(cfg.synonyms.size).toBe(0);
  expect(cfg.skipped[0]?.reason).toContain("no authored term");
});

test("an alias colliding with an authored term key is skipped", () => {
  const raw = [
    "[glossary.terms]",
    'CDR = "Our append-only audit row."',
    "[glossary.synonyms]",
    'cdr = "CDR"',
  ].join("\n");
  const cfg = loadedOrThrow(parseGlossaryManualToml(raw));
  expect(cfg.synonyms.size).toBe(0);
  expect(cfg.skipped[0]?.reason).toContain("is itself an authored term");
});

test("two raw keys normalizing to one term_key take the last and warn", () => {
  const raw = ["[glossary.terms]", 'CDR = "first"', 'Cdr = "second"'].join("\n");
  const cfg = loadedOrThrow(parseGlossaryManualToml(raw));
  expect(cfg.terms).toHaveLength(1);
  expect(cfg.terms[0]?.definition).toBe("second");
  expect(cfg.terms[0]?.displayTerm).toBe("Cdr");
  expect(cfg.skipped[0]?.reason).toContain("duplicate");
});

test("keys outside the two blocks are ignored", () => {
  const raw = [
    "[glossary]",
    "min_doc_freq = 9",
    "[glossary.terms]",
    'CDR = "Our append-only audit row."',
  ].join("\n");
  const cfg = loadedOrThrow(parseGlossaryManualToml(raw));
  expect(cfg.terms).toHaveLength(1);
});

test("a duplicate alias takes the last and warns", () => {
  const raw = [
    "[glossary.terms]",
    'CDR = "Our append-only audit row."',
    'CDX = "Something else."',
    "[glossary.synonyms]",
    '"change data record" = "CDR"',
    '"change data record" = "CDX"',
  ].join("\n");
  const cfg = loadedOrThrow(parseGlossaryManualToml(raw));
  expect(cfg.synonyms.get("change data record")).toBe("cdx");
  expect(cfg.skipped.some((s) => s.reason.includes("duplicate alias"))).toBe(true);
});

test("a dotted key under [glossary] is reported, not silently ignored", () => {
  // `[glossary]` + `terms.CDR = "..."` is valid TOML that this line parser
  // cannot see. Silence would leave the user with a term that never appears
  // and no explanation.
  const raw = ["[glossary]", 'terms.CDR = "Our append-only audit row."'].join("\n");
  const cfg = loadedOrThrow(parseGlossaryManualToml(raw));
  expect(cfg.terms).toEqual([]);
  expect(cfg.skipped[0]?.entry).toBe("terms.CDR");
  expect(cfg.skipped[0]?.reason).toContain("[glossary.terms]");
});

test("an ordinary [glossary] key is not mistaken for a misplaced term", () => {
  const cfg = loadedOrThrow(parseGlossaryManualToml("[glossary]\nmin_doc_freq = 9"));
  expect(cfg.skipped).toEqual([]);
});

test("a missing config file yields loaded:false, NOT an empty config", () => {
  const dir = mkdtempSync(join(tmpdir(), "nimbus-glossary-cfg-"));
  expect(loadGlossaryManualFromConfigDir(dir)).toEqual({ loaded: false });
});

test("a readable config file yields loaded:true", () => {
  const dir = mkdtempSync(join(tmpdir(), "nimbus-glossary-cfg-"));
  writeFileSync(join(dir, "nimbus.toml"), '[glossary.terms]\nCDR = "x"\n', "utf8");
  const cfg = loadedOrThrow(loadGlossaryManualFromConfigDir(dir));
  expect(cfg.terms).toHaveLength(1);
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
bun test packages/gateway/src/config/nimbus-toml-glossary-terms.test.ts > /tmp/t4.txt 2>&1; echo "EXIT=$?"; tail -20 /tmp/t4.txt
```

Expected: FAIL — module not found.

- [ ] **Step 3: Write the parser**

Create `packages/gateway/src/config/nimbus-toml-glossary-terms.ts`:

```ts
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { normalizeTerm } from "../glossary/term-normalize.ts";
import {
  hasUnterminatedString,
  isTableHeader,
  parseString,
  splitKeyValue,
  stripComment,
} from "./toml-primitives.ts";

/** One authored term. `termKey` is normalized; `displayTerm` is as written. */
export type ManualTerm = { termKey: string; displayTerm: string; definition: string };

/** A rejected config entry, reported to the user by `--refresh` (spec §8). */
export type ManualSkip = { entry: string; reason: string };

/**
 * `loaded: false` means the config could NOT be read — never "there are no
 * authored terms".
 *
 * This distinction is the whole reason the module does not use
 * `loadTomlSection`, which catches every error and returns defaults. Under the
 * desired-state semantics of `glossary-manual.ts`, an unreadable file
 * interpreted as an empty config would delete every authored term on the
 * machine. The removal half of the pre-pass therefore runs only on
 * `loaded: true`.
 */
export type GlossaryManualConfig =
  | { loaded: false }
  | {
      loaded: true;
      terms: ManualTerm[];
      /** Normalized alias -> the `termKey` it resolves to. */
      synonyms: Map<string, string>;
      skipped: ManualSkip[];
    };

const GLOSSARY_HEADER = "[glossary]";
const TERMS_HEADER = "[glossary.terms]";
const SYNONYMS_HEADER = "[glossary.synonyms]";

type RawEntry = { key: string; value: string };

/**
 * Collects the raw entries of both blocks in one pass.
 *
 * A dedicated loop rather than `forEachSectionEntry` because this parser must
 * report WHY an entry was rejected, and that helper deliberately discards the
 * distinction between "no `=` on the line" and "not in this section".
 *
 * `misplaced` catches the one *valid TOML* shape this line parser cannot see:
 * a dotted key under the parent table (`[glossary]` + `terms.CDR = "…"`).
 * Full TOML compliance is out of scope — the parser is deliberately
 * dependency-free — but silently ignoring a correctly-written term is the
 * silent-failure class this whole slice exists to remove, so it is reported
 * through the same `skipped` channel as any other rejected entry.
 */
function collectBlocks(raw: string): {
  terms: RawEntry[];
  synonyms: RawEntry[];
  misplaced: ManualSkip[];
} {
  const terms: RawEntry[] = [];
  const synonyms: RawEntry[] = [];
  const misplaced: ManualSkip[] = [];
  let target: RawEntry[] | null = null;
  let inGlossaryRoot = false;

  for (const line of raw.split(/\r?\n/)) {
    if (hasUnterminatedString(line)) continue;
    const trimmed = stripComment(line).trim();
    if (trimmed === "") continue;
    if (isTableHeader(trimmed)) {
      inGlossaryRoot = trimmed === GLOSSARY_HEADER;
      if (trimmed === TERMS_HEADER) target = terms;
      else if (trimmed === SYNONYMS_HEADER) target = synonyms;
      else target = null;
      continue;
    }
    if (inGlossaryRoot) {
      const kv = splitKeyValue(trimmed);
      const key = kv?.key.trim() ?? "";
      if (key.startsWith("terms.") || key.startsWith("synonyms.")) {
        misplaced.push({
          entry: key,
          reason:
            "dotted keys under [glossary] are not read — move it under [glossary.terms] " +
            "or [glossary.synonyms]",
        });
      }
      continue;
    }
    if (target === null) continue;
    const kv = splitKeyValue(trimmed);
    if (kv !== undefined) {
      target.push({ key: parseString(kv.key), value: parseString(kv.valRaw) });
    }
  }
  return { terms, synonyms, misplaced };
}

function buildTerms(raw: RawEntry[], skipped: ManualSkip[]): ManualTerm[] {
  const byKey = new Map<string, ManualTerm>();
  for (const { key, value } of raw) {
    const termKey = normalizeTerm(key);
    if (termKey === "") {
      skipped.push({ entry: key, reason: "key normalizes to nothing" });
      continue;
    }
    if (value.trim() === "") {
      skipped.push({ entry: key, reason: "empty definition" });
      continue;
    }
    if (byKey.has(termKey)) {
      // Two DIFFERENT raw keys normalizing to one term_key ("CDR" and "Cdr")
      // is last-wins like any duplicate, but unlike a literal duplicate it is
      // almost certainly a mistake, so it is reported.
      skipped.push({ entry: key, reason: `duplicate of an earlier entry for "${termKey}"` });
    }
    byKey.set(termKey, { termKey, displayTerm: key, definition: value.trim() });
  }
  return [...byKey.values()];
}

function buildSynonyms(
  raw: RawEntry[],
  terms: readonly ManualTerm[],
  skipped: ManualSkip[],
): Map<string, string> {
  const authored = new Set(terms.map((t) => t.termKey));
  const out = new Map<string, string>();
  for (const { key, value } of raw) {
    const alias = normalizeTerm(key);
    const target = normalizeTerm(value);
    if (alias === "" || target === "") {
      skipped.push({ entry: key, reason: "alias or target normalizes to nothing" });
      continue;
    }
    if (authored.has(alias)) {
      skipped.push({ entry: key, reason: "alias is itself an authored term" });
      continue;
    }
    if (!authored.has(target)) {
      // Aliases resolve only to AUTHORED terms in this slice. Pointing one at
      // a mined term would pull a mined row into the desired-state
      // reconciliation, which is a separate decision (spec §4).
      skipped.push({ entry: key, reason: `no authored term "${value}" to alias` });
      continue;
    }
    if (out.has(alias)) {
      // Last-wins, matching `buildTerms` and every other section of this
      // parser — but reported, because two aliases for the same phrase
      // pointing at different terms is a mistake, not an override.
      skipped.push({ entry: key, reason: `duplicate alias definition for "${key}"` });
    }
    out.set(alias, target);
  }
  return out;
}

export function parseGlossaryManualToml(raw: string): GlossaryManualConfig {
  const blocks = collectBlocks(raw);
  const skipped: ManualSkip[] = [...blocks.misplaced];
  const terms = buildTerms(blocks.terms, skipped);
  const synonyms = buildSynonyms(blocks.synonyms, terms, skipped);
  return { loaded: true, terms, synonyms, skipped };
}

/**
 * Reads `<configDir>/nimbus.toml`.
 *
 * Deliberately NOT built on `loadTomlSection`: every failure must surface as
 * `loaded: false` rather than as an empty-but-valid config. See the
 * `GlossaryManualConfig` docstring.
 */
export function loadGlossaryManualFromConfigDir(configDir: string): GlossaryManualConfig {
  const tomlPath = join(configDir, "nimbus.toml");
  if (!existsSync(tomlPath)) return { loaded: false };
  try {
    return parseGlossaryManualToml(readFileSync(tomlPath, "utf8"));
  } catch {
    return { loaded: false };
  }
}
```

- [ ] **Step 4: Run the tests to verify they pass**

```bash
bun test packages/gateway/src/config/nimbus-toml-glossary-terms.test.ts > /tmp/t4.txt 2>&1; echo "EXIT=$?"; tail -20 /tmp/t4.txt
```

Expected: `EXIT=0`, 12 pass.

- [ ] **Step 5: Red-prove the `loaded` fail-safe**

This is the single most important assertion in the feature. Temporarily change `if (!existsSync(tomlPath)) return { loaded: false };` to `return { loaded: true, terms: [], synonyms: new Map(), skipped: [] };`. Run Step 4 — the missing-file test must fail on its **assertion** (`Expected: {loaded: false} Received: {loaded: true, …}`), not by throwing. Restore, confirm green.

- [ ] **Step 6: Commit**

```bash
git add packages/gateway/src/config/nimbus-toml-glossary-terms.ts \
        packages/gateway/src/config/nimbus-toml-glossary-terms.test.ts
git commit -F - <<'MSG'
feat(config): parse [glossary.terms] and [glossary.synonyms]

Flat blocks, so a quoted key handles dots and spaces ("node.js") without
moving the term into a table header where it would be ambiguous.

Deliberately not built on loadTomlSection: that helper returns defaults on
ANY read failure, which under the desired-state removal semantics of the
next commit would read as "the user deleted every term". The loader
reports loaded:false instead, and only the upsert half runs in that state.

Collects per-entry skip reasons, which forEachSectionEntry discards, so
--refresh can tell the user why an entry was rejected.
MSG
```

---

## Task 5: The manual pre-pass

**Files:**

- Create: `packages/gateway/src/glossary/glossary-manual.ts`
- Create: `packages/gateway/src/glossary/glossary-manual.test.ts`
- Modify: `packages/gateway/src/glossary/glossary-store.ts` (add `upsertManualTerm`, `listManualKeys`)

**Interfaces:**

- Consumes: `GlossaryManualConfig`, `ManualTerm` (Task 4); `computeTermStats`, `demoteTerm`, `getTerm` from `glossary-store.ts`; `projectTerm`, `unprojectTerm` from `glossary-project.ts`; `findNearMisses` from `near-miss.ts`; `scoreTerm` from `term-scoring.ts`.
- Produces:

```ts
export type ManualPassSummary = { added: number; removed: number; skipped: ManualSkip[] };
export function applyManualTerms(
  db: Database,
  cfg: GlossaryManualConfig,
  opts: { nowMs: number },
): ManualPassSummary;
```

and in the store:

```ts
export function upsertManualTerm(db: Database, p: { … }): void;
export function listManualKeys(db: Database): string[];
```

- [ ] **Step 1: Write the failing test**

Create `packages/gateway/src/glossary/glossary-manual.test.ts`:

```ts
import { Database } from "bun:sqlite";
import { beforeEach, expect, test } from "bun:test";

import type { GlossaryManualConfig } from "../config/nimbus-toml-glossary-terms.ts";
import { CURRENT_SCHEMA_VERSION } from "../index/local-index.ts";
import { upsertIndexedItem } from "../index/item-store.ts";
import { runIndexedSchemaMigrations } from "../index/migrations/runner.ts";
import { applyManualTerms } from "./glossary-manual.ts";
import { glossaryItemExternalId } from "./glossary-project.ts";
import { getTerm } from "./glossary-store.ts";

let db: Database;

beforeEach(() => {
  db = new Database(":memory:");
  runIndexedSchemaMigrations(db, CURRENT_SCHEMA_VERSION);
});

function cfg(
  terms: Array<{ termKey: string; displayTerm: string; definition: string }>,
  synonyms: Array<[string, string]> = [],
): GlossaryManualConfig {
  return { loaded: true, terms, synonyms: new Map(synonyms), skipped: [] };
}

/** Indexes `count` items whose text mentions `term`, so FTS can evidence it. */
function seedEvidence(term: string, count: number): void {
  for (let i = 0; i < count; i += 1) {
    upsertIndexedItem(db, {
      service: "slack",
      type: "message",
      externalId: `m${String(i)}`,
      title: `About ${term}`,
      bodyPreview: `We discussed ${term} at length today.`,
      url: null,
      canonicalUrl: null,
      modifiedAt: 1000 + i,
      syncedAt: 1,
      metadata: {},
    });
  }
}

function projectedExists(termKey: string): boolean {
  return (
    db
      .query("SELECT 1 FROM item WHERE service = 'nimbus' AND external_id = ?")
      .get(glossaryItemExternalId(termKey)) !== null
  );
}

test("an authored term lands consolidated with definition_source manual", () => {
  applyManualTerms(db, cfg([{ termKey: "cdr", displayTerm: "CDR", definition: "Audit row." }]), {
    nowMs: 5000,
  });
  const t = getTerm(db, "cdr");
  expect(t?.status).toBe("consolidated");
  expect(t?.definitionSource).toBe("manual");
  expect(t?.definition).toBe("Audit row.");
  expect(t?.displayTerm).toBe("CDR");
  expect(projectedExists("cdr")).toBe(true);
});

test("an authored term with no mined evidence is still accepted", () => {
  applyManualTerms(db, cfg([{ termKey: "cdr", displayTerm: "CDR", definition: "Audit row." }]), {
    nowMs: 5000,
  });
  const t = getTerm(db, "cdr");
  expect(t?.status).toBe("consolidated");
  expect(t?.docFreq).toBe(0);
});

test("statistics are measured when evidence exists", () => {
  seedEvidence("widget", 4);
  applyManualTerms(
    db,
    cfg([{ termKey: "widget", displayTerm: "Widget", definition: "A thing." }]),
    { nowMs: 5000 },
  );
  const t = getTerm(db, "widget");
  expect(t?.docFreq).toBe(4);
  expect(t?.topSources.length).toBeGreaterThan(0);
});

test("synonyms from config reach the row", () => {
  applyManualTerms(
    db,
    cfg([{ termKey: "cdr", displayTerm: "CDR", definition: "Audit row." }], [
      ["change data record", "cdr"],
    ]),
    { nowMs: 5000 },
  );
  expect(getTerm(db, "cdr")?.synonyms).toEqual(["change data record"]);

  // Also reach the PROJECTED body, not just the row: item_fts indexes only
  // title and body_preview, so a synonym living in the row alone would leave
  // `nimbus ask "what does change data record mean?"` finding nothing.
  const projected = db
    .query("SELECT body_preview FROM item WHERE service = 'nimbus' AND external_id = ?")
    .get(glossaryItemExternalId("cdr")) as { body_preview: string } | null;
  expect(projected?.body_preview).toContain("change data record");
});

test("an edited definition replaces the stored one", () => {
  applyManualTerms(db, cfg([{ termKey: "cdr", displayTerm: "CDR", definition: "First." }]), {
    nowMs: 5000,
  });
  applyManualTerms(db, cfg([{ termKey: "cdr", displayTerm: "CDR", definition: "Second." }]), {
    nowMs: 6000,
  });
  expect(getTerm(db, "cdr")?.definition).toBe("Second.");
});

test("an edited display form replaces the stored one", () => {
  // The pre-pass upsert overwrites display_term UNCONDITIONALLY — the opposite
  // of the mining upsert's policy. Both directions are pinned; see the
  // mining-side test in glossary-extract.test.ts.
  applyManualTerms(db, cfg([{ termKey: "cdr", displayTerm: "CDR", definition: "d" }]), {
    nowMs: 5000,
  });
  applyManualTerms(db, cfg([{ termKey: "cdr", displayTerm: "CDRs", definition: "d" }]), {
    nowMs: 6000,
  });
  expect(getTerm(db, "cdr")?.displayTerm).toBe("CDRs");
});

test("an unchanged term is not rewritten on a later pass", () => {
  const conf = cfg([{ termKey: "cdr", displayTerm: "CDR", definition: "Audit row." }]);
  applyManualTerms(db, conf, { nowMs: 5000 });

  const second = applyManualTerms(db, conf, { nowMs: 6000 });

  expect(second.added).toBe(0);
  // `updated_at` is the tell: an unchanged term must not be touched at all,
  // because touching it means recomputing its statistics (2 FTS queries) on
  // every pass, after every connector sync, forever.
  expect(getTerm(db, "cdr")?.updatedAt).toBe(5000);
});

test("a changed definition IS rewritten even when the display form matches", () => {
  // Guards the unchanged-check against being too eager. Separate fixtures for
  // each field, so a check that compares only one of them cannot pass.
  applyManualTerms(db, cfg([{ termKey: "cdr", displayTerm: "CDR", definition: "First." }]), {
    nowMs: 5000,
  });
  const second = applyManualTerms(
    db,
    cfg([{ termKey: "cdr", displayTerm: "CDR", definition: "Second." }]),
    { nowMs: 6000 },
  );
  expect(second.added).toBe(1);
  expect(getTerm(db, "cdr")?.definition).toBe("Second.");
});

test("a changed synonym set IS rewritten even when the definition matches", () => {
  const term = { termKey: "cdr", displayTerm: "CDR", definition: "Audit row." };
  applyManualTerms(db, cfg([term]), { nowMs: 5000 });
  const second = applyManualTerms(db, cfg([term], [["change data record", "cdr"]]), {
    nowMs: 6000,
  });
  expect(second.added).toBe(1);
  expect(getTerm(db, "cdr")?.synonyms).toEqual(["change data record"]);
});

test("removal demotes the row and deletes its projected item", () => {
  applyManualTerms(db, cfg([{ termKey: "cdr", displayTerm: "CDR", definition: "Audit row." }]), {
    nowMs: 5000,
  });
  expect(projectedExists("cdr")).toBe(true);

  const summary = applyManualTerms(db, cfg([]), { nowMs: 6000 });

  expect(summary.removed).toBe(1);
  const t = getTerm(db, "cdr");
  expect(t?.status).toBe("pending");
  expect(t?.definition).toBeNull();
  expect(t?.definitionSource).toBeNull();
  expect(projectedExists("cdr")).toBe(false);
});

test("an unreadable config deletes nothing", () => {
  applyManualTerms(db, cfg([{ termKey: "cdr", displayTerm: "CDR", definition: "Audit row." }]), {
    nowMs: 5000,
  });

  const summary = applyManualTerms(db, { loaded: false }, { nowMs: 6000 });

  expect(summary.removed).toBe(0);
  expect(getTerm(db, "cdr")?.status).toBe("consolidated");
  expect(projectedExists("cdr")).toBe(true);
});

test("removal leaves a mined term's own row alone", () => {
  seedEvidence("widget", 4);
  applyManualTerms(db, cfg([{ termKey: "cdr", displayTerm: "CDR", definition: "d" }]), {
    nowMs: 5000,
  });
  db.run(
    `INSERT INTO glossary_term
       (term_key, display_term, status, definition, definition_source,
        doc_freq, first_seen_at, last_seen_at, updated_at)
     VALUES ('widget', 'Widget', 'consolidated', 'mined', 'llm', 4, 1, 2, 3)`,
  );

  applyManualTerms(db, cfg([]), { nowMs: 6000 });

  const mined = getTerm(db, "widget");
  expect(mined?.status).toBe("consolidated");
  expect(mined?.definition).toBe("mined");
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
bun test packages/gateway/src/glossary/glossary-manual.test.ts > /tmp/t5.txt 2>&1; echo "EXIT=$?"; tail -20 /tmp/t5.txt
```

Expected: FAIL — module not found.

- [ ] **Step 3: Add the two store functions**

Append to `packages/gateway/src/glossary/glossary-store.ts`:

```ts
/**
 * Writes an authored term straight to `consolidated`.
 *
 * There is nothing to consolidate — the human supplied the definition — so
 * these rows never enter the pending queue, never consume a slot of
 * `max_new_terms_per_pass`, and never cost a model call.
 *
 * `display_term = excluded.display_term` is UNCONDITIONAL here, which is the
 * exact opposite of `upsertCandidate`'s policy for a manual row. That is
 * deliberate and the two must not be unified: an author who restyles `CDR` to
 * `CDRs` in config is explicitly changing the surface form, while a mined
 * sighting must never overwrite it. One rule: the authored form beats a mined
 * one, and the newest authored form beats an older authored one.
 */
export function upsertManualTerm(
  db: Database,
  p: {
    termKey: string;
    displayTerm: string;
    definition: string;
    synonyms: string[];
    nearMisses: string[];
    stats: TermStats;
    score: number;
    nowMs: number;
  },
): void {
  dbRun(
    db,
    `INSERT INTO glossary_term (
       term_key, display_term, status, definition, definition_source,
       doc_freq, service_spread, score, first_seen_at, last_seen_at,
       top_sources, synonyms, near_misses, consolidated_at,
       stats_verified_at, updated_at
     ) VALUES (?, ?, 'consolidated', ?, 'manual', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(term_key) DO UPDATE SET
       display_term = excluded.display_term,
       status = 'consolidated',
       definition = excluded.definition,
       definition_source = 'manual',
       doc_freq = excluded.doc_freq,
       service_spread = excluded.service_spread,
       score = excluded.score,
       first_seen_at = excluded.first_seen_at,
       last_seen_at = excluded.last_seen_at,
       top_sources = excluded.top_sources,
       synonyms = excluded.synonyms,
       near_misses = excluded.near_misses,
       consolidated_at = excluded.consolidated_at,
       stats_verified_at = excluded.stats_verified_at,
       updated_at = excluded.updated_at`,
    [
      p.termKey,
      p.displayTerm,
      p.definition,
      p.stats.docFreq,
      p.stats.serviceSpread,
      p.score,
      p.stats.firstSeenAt,
      p.stats.lastSeenAt,
      JSON.stringify(p.stats.topSources),
      JSON.stringify(p.synonyms),
      JSON.stringify(p.nearMisses),
      p.nowMs,
      p.nowMs,
      p.nowMs,
    ],
  );
}

/** Every row currently sourced from `[glossary.terms]`. */
export function listManualKeys(db: Database): string[] {
  const rows = db
    .query("SELECT term_key FROM glossary_term WHERE definition_source = 'manual'")
    .all() as Array<{ term_key: string }>;
  return rows.map((r) => r.term_key);
}
```

- [ ] **Step 4: Write the pre-pass**

Create `packages/gateway/src/glossary/glossary-manual.ts`:

```ts
import type { Database } from "bun:sqlite";

import type {
  GlossaryManualConfig,
  ManualSkip,
  ManualTerm,
} from "../config/nimbus-toml-glossary-terms.ts";
import { projectTerm, unprojectTerm } from "./glossary-project.ts";
import type { GlossaryTerm } from "./glossary-types.ts";
import {
  computeTermStats,
  demoteTerm,
  getTerm,
  listConsolidated,
  listManualKeys,
  upsertManualTerm,
} from "./glossary-store.ts";
import { scoreTerm } from "./term-scoring.ts";
import { findNearMisses } from "./near-miss.ts";

export type ManualPassSummary = { added: number; removed: number; skipped: ManualSkip[] };

/** Mirrors `agents/glossary.ts` and `glossary-extract.ts`. */
const NEAR_MISS_POOL = 500;

/**
 * True when the stored row already matches what the author wrote.
 *
 * Compares only AUTHORED content — definition, display form, synonyms — and
 * deliberately not statistics: those move on their own as the index changes,
 * and treating them as a difference would re-write every row every pass, which
 * is the cost this check exists to avoid. A row that is not `manual` is never
 * "unchanged": that is a mined row being taken over by an authored one.
 */
function isUnchanged(
  existing: GlossaryTerm | null,
  term: ManualTerm,
  aliases: readonly string[],
): boolean {
  return (
    existing !== null &&
    existing.definitionSource === "manual" &&
    existing.definition === term.definition &&
    existing.displayTerm === term.displayTerm &&
    existing.synonyms.join(" ") === aliases.join(" ")
  );
}

/**
 * The authoring pre-pass. Runs at the head of every glossary pass.
 *
 * Config is DESIRED STATE for the `definition_source='manual'` subspace, and
 * only for that subspace: an authored key is upserted, and a manual row whose
 * key vanished from config is demoted.
 *
 * Demotion rather than deletion is what makes "remove my override" mean the
 * right thing. The existing `selectPendingBatch` filter (`doc_freq >=
 * min_doc_freq`) then discriminates without a new branch: a term with real
 * mined evidence re-enters the consolidation queue and comes back with a mined
 * definition, while a pure invention sits below the floor, never selected and
 * never projected. Hard deletion would lose the first case entirely, because
 * `discoverPhase` only scans past the watermark and would never re-discover it.
 */
export function applyManualTerms(
  db: Database,
  cfg: GlossaryManualConfig,
  opts: { nowMs: number },
): ManualPassSummary {
  if (!cfg.loaded) {
    // The config could not be READ — which is not the same as "there are no
    // authored terms". Removing rows here would wipe the user's authored
    // glossary on a transient read failure. Fail safe: touch nothing.
    return { added: 0, removed: 0, skipped: [] };
  }

  const aliasesFor = new Map<string, string[]>();
  for (const [alias, termKey] of cfg.synonyms) {
    aliasesFor.set(termKey, [...(aliasesFor.get(termKey) ?? []), alias]);
  }

  const knownKeys = listConsolidated(db, NEAR_MISS_POOL).map((t) => t.termKey);
  let added = 0;

  for (const term of cfg.terms) {
    // Skip a term whose authored content has not changed.
    //
    // Without this, every pass recomputes statistics for every authored term —
    // 2 FTS queries each, on a pass that fires after EVERY connector sync. A
    // team checking a 500-term glossary into nimbus.toml would spend 1000 FTS
    // queries per sync re-deriving values that did not move. It is the same
    // waste `reconcilePass`'s `stats_recheck_cooldown_ms` exists to prevent,
    // and the fix is the same: let the sweep refresh statistics on its own
    // round-robin schedule (it now sweeps manual rows — see
    // `glossary-reconcile.ts`) and touch a row here only when the AUTHOR
    // changed something.
    const existing = getTerm(db, term.termKey);
    if (isUnchanged(existing, term, aliasesFor.get(term.termKey) ?? [])) continue;

    // Measured, but EXEMPT from `min_doc_freq` — a human may define a term the
    // sources never mention. doc_freq is still recorded because it is what
    // discriminates the two removal cases above.
    const stats = computeTermStats(db, term.termKey);
    // One transaction PER TERM, not one for the whole pre-pass.
    //
    // The unit of atomicity is deliberately the term, matching
    // `consolidatePhase`, which wraps each term for the same reason: a crash
    // between the row write and the projection would strand a `consolidated`
    // row with no searchable item, and the reconciliation sweep only
    // re-verifies rows that are already consolidated, so nothing would repair
    // it.
    //
    // Batching the whole loop into one transaction was considered and
    // rejected. It would make a single failing entry discard every OTHER
    // authored term's update — and this reads a file a human is actively
    // editing, where a bad entry is the expected case rather than the
    // exceptional one. The commit-count cost that would motivate batching is
    // removed by the unchanged-skip above, which makes the steady-state pass
    // write nothing at all.
    db.transaction(() => {
      upsertManualTerm(db, {
        termKey: term.termKey,
        displayTerm: term.displayTerm,
        definition: term.definition,
        synonyms: aliasesFor.get(term.termKey) ?? [],
        nearMisses: findNearMisses(term.termKey, knownKeys),
        stats,
        score: scoreTerm({
          docFreq: stats.docFreq,
          serviceSpread: stats.serviceSpread,
          form: "phrase",
        }),
        nowMs: opts.nowMs,
      });
      const stored = getTerm(db, term.termKey);
      if (stored !== null) projectTerm(db, stored, opts.nowMs);
    })();
    added += 1;
  }

  const configured = new Set(cfg.terms.map((t) => t.termKey));
  let removed = 0;
  for (const key of listManualKeys(db)) {
    if (configured.has(key)) continue;
    // The same transaction `glossary-reconcile.ts` runs for a below-floor
    // term. `demoteTerm` nulls `definition_source`, so a demoted row is no
    // longer selected by `listManualKeys` on the next pass.
    db.transaction(() => {
      unprojectTerm(db, key);
      demoteTerm(db, key, opts.nowMs);
    })();
    removed += 1;
  }

  return { added, removed, skipped: cfg.skipped };
}
```

- [ ] **Step 5: Run the tests to verify they pass**

```bash
bun test packages/gateway/src/glossary/glossary-manual.test.ts > /tmp/t5.txt 2>&1; echo "EXIT=$?"; tail -20 /tmp/t5.txt
```

Expected: `EXIT=0`, 9 pass.

- [ ] **Step 6: Red-prove the fail-safe and the removal**

Temporarily delete the `if (!cfg.loaded)` early return (replace with `if (!cfg.loaded) cfg = { loaded: true, terms: [], synonyms: new Map(), skipped: [] };` — you will need a `let` binding). Re-run: the unreadable-config test must fail on `expect(getTerm(db, "cdr")?.status).toBe("consolidated")`, i.e. it must report `Received: "pending"`. That proves the test detects deletion rather than merely detecting a throw. Restore.

Then temporarily remove `unprojectTerm(db, key)` from the removal transaction. Re-run: the removal test must fail on `expect(projectedExists("cdr")).toBe(false)` while its status assertions still pass — proving the projection assertion is load-bearing and not redundant with the status one. Restore, confirm green.

Then red-prove the unchanged-skip in both directions. First delete the `if (isUnchanged(...)) continue;` line — the unchanged test must fail on `expect(...updatedAt).toBe(5000)`, showing `6000`. Restore. Then weaken `isUnchanged` to compare only `existing.definition === term.definition` — the changed-synonym test must fail on `second.added`, showing `0`. This is what proves the per-field fixtures separate; a single fixture varying everything at once would pass against either version.

- [ ] **Step 7: Commit**

```bash
git add packages/gateway/src/glossary/glossary-manual.ts \
        packages/gateway/src/glossary/glossary-manual.test.ts \
        packages/gateway/src/glossary/glossary-store.ts
git commit -F - <<'MSG'
feat(glossary): the manual authoring pre-pass

Config is desired state for the definition_source='manual' subspace only.
An authored key is upserted straight to consolidated — no model call, no
pending queue, no budget slot. A manual row whose key left config is
DEMOTED, not deleted, so selectPendingBatch's existing doc_freq floor
discriminates for free: a term with real evidence re-consolidates from
sources, a pure invention sits below the floor and disappears.

Hard deletion would lose the first case, because discoverPhase only scans
past the watermark and would never re-discover the term.

The removal half runs only on loaded:true, so a transient config read
failure cannot wipe an authored glossary.
MSG
```

---

## Task 6: Mining and sweep guards

**Files:**

- Modify: `packages/gateway/src/glossary/glossary-store.ts` (`upsertCandidate` `display_term` guard)
- Modify: `packages/gateway/src/glossary/glossary-reconcile.ts` (never demote a manual row)
- Modify: `packages/gateway/src/glossary/glossary-reconcile.test.ts`
- Modify: `packages/gateway/src/glossary/glossary-store.test.ts`

**Interfaces:**

- Consumes: `upsertManualTerm` (Task 5).
- Produces: no new exports; behaviour changes only.

**Two guards, for two different reasons.**

1. `upsertCandidate`'s `ON CONFLICT` refreshes a manual row's statistics when the term is also mined — which is wanted — but it also writes `display_term = excluded.display_term`, silently replacing the author's chosen surface form with whatever form mining saw. This passes every obvious test: definition, status and statistics are all still correct.
2. `selectStaleForRecheck` filters `status='consolidated'`, which *includes* manual rows. They must be re-measured and re-projected (so `top_sources` self-heal when a cited thread is deleted) but never demoted, whatever their `doc_freq`.

**Veto exemption needs no guard and must not get one.** `selectPendingBatch` filters `status='pending'` and `selectSnippetUpgradeBatch` filters `definition_source='snippet'`; a manual row is `consolidated`+`manual`, so neither can select it. A redundant guard would imply they could and hide the real reason. It is asserted by test instead.

- [ ] **Step 1: Write the failing tests**

Append to `packages/gateway/src/glossary/glossary-store.test.ts` (match the file's existing `db` setup and imports; add `upsertManualTerm`, `selectPendingBatch`, `selectSnippetUpgradeBatch` to the import list if absent):

```ts
test("a mined sighting refreshes a manual row's stats but not its display form", () => {
  upsertManualTerm(db, {
    termKey: "cdr",
    displayTerm: "CDR",
    definition: "Authored.",
    synonyms: [],
    nearMisses: [],
    stats: { docFreq: 0, serviceSpread: 0, firstSeenAt: 0, lastSeenAt: 0, topSources: [] },
    score: 0,
    nowMs: 1000,
  });

  upsertCandidate(db, {
    key: "cdr",
    surface: "cdr",
    form: "acronym",
    stats: { docFreq: 7, serviceSpread: 2, firstSeenAt: 10, lastSeenAt: 20, topSources: [] },
    score: 9,
    nowMs: 2000,
  });

  const t = getTerm(db, "cdr");
  expect(t?.displayTerm).toBe("CDR"); // authored form survives
  expect(t?.docFreq).toBe(7); // statistics DO refresh
  expect(t?.definition).toBe("Authored.");
  expect(t?.status).toBe("consolidated");
});

test("a mined sighting still updates a mined row's display form", () => {
  // The other direction of the same CASE expression. A test for either alone
  // passes against the wrong implementation of the other.
  upsertCandidate(db, {
    key: "widget",
    surface: "widget",
    form: "phrase",
    stats: { docFreq: 3, serviceSpread: 1, firstSeenAt: 1, lastSeenAt: 2, topSources: [] },
    score: 1,
    nowMs: 1000,
  });
  upsertCandidate(db, {
    key: "widget",
    surface: "Widget",
    form: "phrase",
    stats: { docFreq: 4, serviceSpread: 1, firstSeenAt: 1, lastSeenAt: 2, topSources: [] },
    score: 2,
    nowMs: 2000,
  });
  expect(getTerm(db, "widget")?.displayTerm).toBe("Widget");
});

test("a manual row is selected by neither consolidation batch", () => {
  upsertManualTerm(db, {
    termKey: "cdr",
    displayTerm: "CDR",
    definition: "Authored.",
    synonyms: [],
    nearMisses: [],
    stats: { docFreq: 9, serviceSpread: 3, firstSeenAt: 1, lastSeenAt: 2, topSources: [] },
    score: 99,
    nowMs: 1000,
  });

  // High score, zero attempts, well above the floor — it qualifies on every
  // predicate except the ones that structurally exclude it.
  const pending = selectPendingBatch(db, 10, {
    nowMs: 9_000_000,
    retryBaseCooldownMs: 1,
    minDocFreq: 3,
  });
  const upgrades = selectSnippetUpgradeBatch(db, 10, {
    nowMs: 9_000_000,
    retryBaseCooldownMs: 1,
  });

  expect(pending.map((t) => t.termKey)).not.toContain("cdr");
  expect(upgrades.map((t) => t.termKey)).not.toContain("cdr");
});
```

Append to `packages/gateway/src/glossary/glossary-reconcile.test.ts` (match its existing setup):

```ts
test("the sweep refreshes a manual row's stats but never demotes it", () => {
  // doc_freq is genuinely below the floor: no item in the index mentions it.
  upsertManualTerm(db, {
    termKey: "cdr",
    displayTerm: "CDR",
    definition: "Authored.",
    synonyms: [],
    nearMisses: [],
    stats: { docFreq: 5, serviceSpread: 1, firstSeenAt: 1, lastSeenAt: 2, topSources: [] },
    score: 5,
    nowMs: 0,
  });

  const summary = reconcilePass(db, {
    limit: 50,
    minDocFreq: 3,
    nowMs: 1_000_000,
    cooldownMs: 0,
  });

  expect(summary.demoted).not.toContain("cdr");
  const t = getTerm(db, "cdr");
  expect(t?.status).toBe("consolidated");
  expect(t?.definition).toBe("Authored.");
  expect(t?.definitionSource).toBe("manual");
  // Stats WERE re-measured — the stale 5 is corrected down to the real 0.
  expect(t?.docFreq).toBe(0);
  expect(t?.statsVerifiedAt).toBe(1_000_000);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

```bash
bun test packages/gateway/src/glossary/glossary-store.test.ts packages/gateway/src/glossary/glossary-reconcile.test.ts > /tmp/t6.txt 2>&1; echo "EXIT=$?"; tail -30 /tmp/t6.txt
```

Expected: FAIL — the display form comes back as `cdr` (clobbered), and the manual row is demoted to `pending`.

- [ ] **Step 3: Guard `display_term` in `upsertCandidate`**

In `packages/gateway/src/glossary/glossary-store.ts`, in `upsertCandidate`'s `ON CONFLICT` clause, replace:

```sql
       display_term = excluded.display_term, doc_freq = excluded.doc_freq,
```

with:

```sql
       display_term = CASE WHEN definition_source = 'manual'
                           THEN display_term ELSE excluded.display_term END,
       doc_freq = excluded.doc_freq,
```

and extend the function's existing comment:

```ts
  // ON CONFLICT deliberately leaves `status` untouched: a consolidated or
  // vetoed row must never be silently returned to the pending queue by a
  // later sighting of the same term.
  //
  // `display_term` is guarded for the same class of reason. Refreshing a
  // manual row's STATISTICS from a mined sighting is wanted; overwriting the
  // author's chosen surface form is not. The opposite policy lives in
  // `upsertManualTerm`, where the newest authored form must win — the two are
  // deliberately asymmetric and must not be unified into one helper.
```

- [ ] **Step 4: Exempt manual rows from demotion**

In `packages/gateway/src/glossary/glossary-reconcile.ts`, inside the `for (const term of stale)` loop, replace:

```ts
    const stats = computeTermStats(db, term.termKey);
    if (stats.docFreq < opts.minDocFreq) {
```

with:

```ts
    const stats = computeTermStats(db, term.termKey);
    // A human assertion outranks a doc-frequency floor, so an authored term is
    // never demoted — but it IS still swept. Skipping it entirely (the literal
    // reading of the base spec's §12) would freeze its `top_sources` forever,
    // so an authored term would keep citing threads the user deleted months
    // ago: precisely the failure this sweep exists to prevent.
    const isManual = term.definitionSource === "manual";
    if (!isManual && stats.docFreq < opts.minDocFreq) {
```

- [ ] **Step 5: Run the tests to verify they pass**

```bash
bun test packages/gateway/src/glossary/ > /tmp/t6.txt 2>&1; echo "EXIT=$?"; tail -30 /tmp/t6.txt
```

Expected: `EXIT=0`.

- [ ] **Step 6: Red-prove both guards**

Revert the `CASE` to plain `display_term = excluded.display_term`. Re-run — the first store test must fail on the `displayTerm` assertion while its `docFreq` assertion still passes (proving the fixture separates the two ANDed behaviours). Restore.

Revert `if (!isManual && …)` to `if (…)`. Re-run — the reconcile test must fail on `expect(t?.status).toBe("consolidated")`, not on a throw. Restore, confirm green.

- [ ] **Step 7: Commit**

```bash
git add packages/gateway/src/glossary/glossary-store.ts \
        packages/gateway/src/glossary/glossary-store.test.ts \
        packages/gateway/src/glossary/glossary-reconcile.ts \
        packages/gateway/src/glossary/glossary-reconcile.test.ts
git commit -F - <<'MSG'
feat(glossary): guard authored rows against mining and the sweep

Two narrow guards, both letting an authored row's EVIDENCE move while its
definition and surface form stay put.

upsertCandidate refreshed doc_freq and top_sources on a manual row (wanted)
but also overwrote display_term with whatever form mining happened to see.
That passes every obvious test — definition, status and statistics are all
still correct — so both directions of the CASE are pinned.

reconcilePass swept manual rows and demoted them below the floor. The
exemption is narrowed to demotion only: skipping them entirely would
freeze top_sources, so an authored term would cite deleted threads
forever.

Veto exemption deliberately gets no guard — selectPendingBatch filters on
status and selectSnippetUpgradeBatch on definition_source, so neither can
reach a manual row. Asserted by test so the real reason stays visible.
MSG
```

---

## Task 7: Wire the pre-pass into the pass and the rebuild

**Files:**

- Modify: `packages/gateway/src/glossary/glossary-extract.ts`
- Modify: `packages/gateway/src/glossary/glossary-extract.test.ts`
- Modify: `packages/gateway/src/platform/assemble.ts:445-470`

**Interfaces:**

- Consumes: `applyManualTerms`, `ManualPassSummary` (Task 5); `loadGlossaryManualFromConfigDir` (Task 4).
- Produces: `GlossaryPassOptions` gains `configDir?: string`; `GlossaryPassSummary` gains `manualAdded`, `manualRemoved`, `manualSkipped`.

**The rebuild transaction is the point.** `rebuildGlossary` unprojects everything, truncates, and re-runs the pass. Authored rows are re-read from config on the same pass — but the state in which they are absent must never be *committed*, or a concurrent reader could observe a glossary with the user's own terms missing. Wrapping the unproject + clear + pre-pass in one transaction closes the window entirely rather than merely making it short.

- [ ] **Step 1: Write the failing test**

Append to `packages/gateway/src/glossary/glossary-extract.test.ts`:

```ts
test("a pass upserts authored terms from config", () => {
  const dir = mkdtempSync(join(tmpdir(), "nimbus-glossary-pass-"));
  writeFileSync(
    join(dir, "nimbus.toml"),
    '[glossary.terms]\nCDR = "Our append-only audit row."\n',
    "utf8",
  );

  await runGlossaryPass(db, { ...PASS_OPTS, configDir: dir });

  const t = getTerm(db, "cdr");
  expect(t?.status).toBe("consolidated");
  expect(t?.definitionSource).toBe("manual");
});

test("a rebuild restores authored terms from config", () => {
  const dir = mkdtempSync(join(tmpdir(), "nimbus-glossary-pass-"));
  writeFileSync(join(dir, "nimbus.toml"), '[glossary.terms]\nCDR = "Authored."\n', "utf8");
  await runGlossaryPass(db, { ...PASS_OPTS, configDir: dir });
  expect(getTerm(db, "cdr")?.definitionSource).toBe("manual");

  const summary = await rebuildGlossary(db, { ...PASS_OPTS, configDir: dir });

  const t = getTerm(db, "cdr");
  expect(t?.definitionSource).toBe("manual");
  expect(t?.definition).toBe("Authored.");
  expect(summary.manualAdded).toBe(1);
});

test("a rebuild whose pre-pass fails does not commit the truncation", () => {
  // This is the ATOMICITY assertion, and it is the only honest way to make
  // one here. Sampling a second connection before and after `rebuildGlossary`
  // proves nothing: both reads land after the call is awaited, so they return
  // the same value whether or not the transaction exists. Forcing the pre-pass
  // to throw is what actually distinguishes the two implementations — with the
  // wrapper, the truncation rolls back; without it, the rows are gone.
  const dir = mkdtempSync(join(tmpdir(), "nimbus-glossary-pass-"));
  writeFileSync(join(dir, "nimbus.toml"), '[glossary.terms]\nCDR = "Authored."\n', "utf8");
  await runGlossaryPass(db, { ...PASS_OPTS, configDir: dir });
  const before = listAllKeys(db).length;
  expect(before).toBeGreaterThan(0);

  // `projectTerm` throws on a row with no definition. Making the item table
  // unwritable mid-transaction is the cheapest reachable failure: drop the
  // table the projection writes to, so the pre-pass throws after
  // `clearGlossary` has already run inside the transaction.
  db.run("ALTER TABLE item RENAME TO item_stashed");

  await expect(rebuildGlossary(db, { ...PASS_OPTS, configDir: dir })).rejects.toThrow();

  db.run("ALTER TABLE item_stashed RENAME TO item");
  expect(listAllKeys(db).length).toBe(before);
});

test("a pass with no configDir touches no authored rows", () => {
  // Tests and degraded boots pass no configDir; that must be inert, not a
  // desired-state wipe.
  upsertManualTerm(db, {
    termKey: "cdr",
    displayTerm: "CDR",
    definition: "Authored.",
    synonyms: [],
    nearMisses: [],
    stats: { docFreq: 0, serviceSpread: 0, firstSeenAt: 0, lastSeenAt: 0, topSources: [] },
    score: 0,
    nowMs: 1,
  });
  await runGlossaryPass(db, PASS_OPTS);
  expect(getTerm(db, "cdr")?.status).toBe("consolidated");
});
```

Add to that file's imports:

```ts
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { upsertManualTerm } from "./glossary-store.ts";
```

Mark the three new tests `async` (the file's existing pass tests already are).

- [ ] **Step 2: Run the tests to verify they fail**

```bash
bun test packages/gateway/src/glossary/glossary-extract.test.ts > /tmp/t7.txt 2>&1; echo "EXIT=$?"; tail -30 /tmp/t7.txt
```

Expected: FAIL — `configDir` is not a known option and no authored row appears.

- [ ] **Step 3: Thread config through the pass**

In `packages/gateway/src/glossary/glossary-extract.ts`, add the imports:

```ts
import {
  type GlossaryManualConfig,
  loadGlossaryManualFromConfigDir,
} from "../config/nimbus-toml-glossary-terms.ts";
import { applyManualTerms } from "./glossary-manual.ts";
```

Add to `GlossaryPassOptions`:

```ts
  /**
   * Config directory holding `nimbus.toml`, re-read EVERY pass so
   * `nimbus glossary --refresh` applies an edit without a gateway restart.
   * `assemble.ts` loads the numeric `[glossary]` knobs once at startup, but
   * authored content is what a user actively edits.
   *
   * Optional: a pass without it (tests, a degraded boot) reads no config, and
   * `applyManualTerms` treats that as `loaded: false` — inert, never a
   * desired-state wipe.
   */
  configDir?: string;
```

Add to `GlossaryPassSummary`:

```ts
  /** Authored terms upserted from `[glossary.terms]` this pass. */
  manualAdded: number;
  /** Authored rows demoted because their config entry was removed. */
  manualRemoved: number;
  /** Config entries rejected by validation, for `--refresh` to report. */
  manualSkipped: ManualSkip[];
```

with the type import:

```ts
import type { ManualSkip } from "../config/nimbus-toml-glossary-terms.ts";
```

Add a helper above `runGlossaryPass`:

```ts
function readManualConfig(opts: GlossaryPassOptions): GlossaryManualConfig {
  return opts.configDir === undefined
    ? { loaded: false }
    : loadGlossaryManualFromConfigDir(opts.configDir);
}
```

Rewrite `runGlossaryPass` and `rebuildGlossary`:

```ts
export async function runGlossaryPass(
  db: Database,
  opts: GlossaryPassOptions,
): Promise<GlossaryPassSummary> {
  const llmConfigured = opts.llm !== undefined;
  // The authoring pre-pass runs FIRST, so `discoverPhase`'s `upsertCandidate`
  // refreshes an authored row's statistics in the same pass (its display_term
  // guard keeps the authored surface form).
  const m = applyManualTerms(db, readManualConfig(opts), { nowMs: opts.nowMs });
  const manual = {
    manualAdded: m.added,
    manualRemoved: m.removed,
    manualSkipped: m.skipped,
  };
  const a = discoverPhase(db, opts);
  if (opts.signal?.aborted === true) {
    return {
      ...a,
      ...manual,
      consolidated: 0,
      upgraded: 0,
      vetoed: 0,
      upgradesVetoed: 0,
      vetoedTerms: [],
      retried: 0,
      llmConfigured,
      llmProduced: false,
      aborted: true,
    };
  }
  const b = await consolidatePhase(db, opts);
  return { ...a, ...manual, ...b, llmConfigured };
}

/**
 * Wipes every glossary row and projection, then re-mines from watermark zero.
 *
 * The unproject + truncate + authoring pre-pass run in ONE transaction, so the
 * state in which an authored term is absent is never committed and therefore
 * unobservable to any reader. Correctness comes from the pre-pass being
 * unconditional and model-free — authored rows need no consolidation, so they
 * never wait on the bounded per-pass budget.
 */
export async function rebuildGlossary(
  db: Database,
  opts: GlossaryPassOptions,
): Promise<GlossaryPassSummary> {
  const cfg = readManualConfig(opts);
  let restored: ReturnType<typeof applyManualTerms> = { added: 0, removed: 0, skipped: [] };
  db.transaction(() => {
    for (const key of listAllKeys(db)) unprojectTerm(db, key);
    clearGlossary(db);
    restored = applyManualTerms(db, cfg, { nowMs: opts.nowMs });
  })();

  // The pass below re-runs the pre-pass, which is idempotent: every authored
  // key is already present, so it upserts the same values and removes nothing.
  const summary = await runGlossaryPass(db, opts);
  return { ...summary, manualAdded: restored.added, manualRemoved: restored.removed };
}
```

- [ ] **Step 4: Wire `configDir` in `assemble.ts`**

In `packages/gateway/src/platform/assemble.ts`, inside the `passOpts` object literal (~line 452), add one line after `retryBaseCooldownMs`:

```ts
        // Re-read every pass, unlike the numeric knobs above: authored terms
        // are content a user actively edits, so `--refresh` must apply an edit
        // without a gateway restart.
        configDir: paths.configDir,
```

- [ ] **Step 5: Run the tests to verify they pass**

```bash
bun test packages/gateway/src/glossary/ > /tmp/t7.txt 2>&1; echo "EXIT=$?"; tail -30 /tmp/t7.txt
bunx tsc --noEmit -p packages/gateway/tsconfig.json > /tmp/t7tsc.txt 2>&1; echo "TSC EXIT=$?"; tail -20 /tmp/t7tsc.txt
```

Expected: both `EXIT=0`.

- [ ] **Step 6: Red-prove the rebuild atomicity**

Temporarily move `applyManualTerms(db, cfg, …)` out of the `db.transaction(...)` callback to the line after `})();`. Re-run the failing-pre-pass test — `listAllKeys(db).length` must come back `0` and the final assertion must fail. That is what proves the transaction wrapper is load-bearing; the restore-and-pass test alone would stay green either way, since the outer pass re-creates the row.

Restore, confirm green. Then red-prove the restore test separately by deleting the `applyManualTerms` call from `rebuildGlossary` entirely — `getTerm(db, "cdr")` must come back `null`.

If `ALTER TABLE item RENAME` turns out not to make `projectTerm` throw (check the actual failure mode first — `upsertIndexedItem` may create the table or fail differently), substitute any deterministic throw reachable from inside the transaction and say in the test comment which one you used. Do **not** settle for a test that passes without distinguishing the two implementations.

- [ ] **Step 7: Commit**

```bash
git add packages/gateway/src/glossary/glossary-extract.ts \
        packages/gateway/src/glossary/glossary-extract.test.ts \
        packages/gateway/src/platform/assemble.ts
git commit -F - <<'MSG'
feat(glossary): run the authoring pre-pass at the head of every pass

Config is re-read per pass rather than captured at assemble time, so
`nimbus glossary --refresh` applies an edit without a gateway restart.
The numeric [glossary] knobs keep their startup load — re-reading those
mid-flight would change a running pass's own budget.

The pre-pass runs before discoverPhase, so a mined sighting refreshes an
authored row's statistics in the same pass while its display_term guard
keeps the authored surface form.

rebuildGlossary now wraps unproject + truncate + pre-pass in ONE
transaction. The window where an authored term is absent is not merely
short, it is never committed, so no reader can observe it. A pass with no
configDir reads no config and is inert, never a desired-state wipe.
MSG
```

---

## Task 8: Read path and CLI

**Files:**

- Modify: `packages/gateway/src/glossary/glossary-store.ts` (`listConsolidated` ordering, `countByStatus.manual`)
- Modify: `packages/gateway/src/agents/_lib/glossary-types.ts` (`stats.manual`)
- Modify: `packages/gateway/src/agents/_lib/render.ts:295`
- Modify: `packages/gateway/src/agents/_lib/render.test.ts`
- Modify: `packages/cli/src/commands/glossary.ts`
- Modify: `packages/cli/src/commands/glossary.test.ts`

**Interfaces:**

- Consumes: everything above.
- Produces: `countByStatus` returns `{ total, pending, vetoed, manual }`; `GlossaryBrief.stats` gains `manual: number`.

**`manual` is a SUBSET of `total`, not a fourth bucket.** `total` counts `consolidated` rows, which now include authored ones. Mined count is `total - manual`. Getting this backwards makes the rebuild preview claim more deletions than occur.

- [ ] **Step 1: Write the failing tests**

Append to `packages/gateway/src/glossary/glossary-store.test.ts`:

```ts
test("listConsolidated puts authored terms ahead of higher-scoring mined ones", () => {
  upsertCandidate(db, {
    key: "widget",
    surface: "Widget",
    form: "phrase",
    stats: { docFreq: 50, serviceSpread: 5, firstSeenAt: 1, lastSeenAt: 2, topSources: [] },
    score: 999,
    nowMs: 1,
  });
  markConsolidated(db, {
    termKey: "widget",
    definition: "mined",
    definitionSource: "llm",
    synonyms: [],
    nearMisses: [],
    nowMs: 1,
  });
  upsertManualTerm(db, {
    termKey: "cdr",
    displayTerm: "CDR",
    definition: "authored",
    synonyms: [],
    nearMisses: [],
    stats: { docFreq: 0, serviceSpread: 0, firstSeenAt: 0, lastSeenAt: 0, topSources: [] },
    score: 0,
    nowMs: 1,
  });

  // Ordered, so assert the ORDER — a count would pass against ORDER BY score
  // alone, which is exactly the bug this guards.
  expect(listConsolidated(db, 10).map((t) => t.termKey)).toEqual(["cdr", "widget"]);
});

test("countByStatus reports manual as a subset of total", () => {
  upsertManualTerm(db, {
    termKey: "cdr",
    displayTerm: "CDR",
    definition: "authored",
    synonyms: [],
    nearMisses: [],
    stats: { docFreq: 0, serviceSpread: 0, firstSeenAt: 0, lastSeenAt: 0, topSources: [] },
    score: 0,
    nowMs: 1,
  });
  const counts = countByStatus(db);
  expect(counts.total).toBe(1);
  expect(counts.manual).toBe(1);
});
```

Append to `packages/gateway/src/agents/_lib/render.test.ts` (match its existing brief fixture helper):

```ts
test("an authored definition is labelled as authored, not as a snippet", () => {
  const md = renderGlossaryBrief(
    briefFixture({
      mode: "term",
      entries: [entryFixture({ term: "CDR", definition: "Authored.", definitionSource: "manual" })],
    }),
  );
  expect(md).toContain("nimbus.toml");
  expect(md).not.toContain("quoted verbatim");
});
```

Append to `packages/cli/src/commands/glossary.test.ts`:

```ts
test("the rebuild preview does not claim authored terms will be deleted", () => {
  const out = renderRebuildPreview({ total: 10, pending: 4, manual: 3 }, ["CDR", "widget"]);
  expect(out).toContain("7 mined terms");
  expect(out).toContain("3 authored term");
  expect(out).toContain("nimbus.toml");
});

test("the pass outcome names skipped config entries", () => {
  const lines = renderPassOutcome({
    consolidated: 0,
    upgraded: 0,
    vetoed: 0,
    upgradesVetoed: 0,
    vetoedTerms: [],
    retried: 0,
    llmConfigured: false,
    llmProduced: false,
    manualSkipped: [{ entry: "CDR", reason: "empty definition" }],
  });
  expect(lines.join("\n")).toContain("CDR");
  expect(lines.join("\n")).toContain("empty definition");
});
```

- [ ] **Step 2: Run the tests to verify they fail**

```bash
bun test packages/gateway/src/glossary/glossary-store.test.ts packages/gateway/src/agents/_lib/render.test.ts > /tmp/t8g.txt 2>&1; echo "GW EXIT=$?"; tail -20 /tmp/t8g.txt
bun test packages/cli/src/commands/glossary.test.ts > /tmp/t8c.txt 2>&1; echo "CLI EXIT=$?"; tail -20 /tmp/t8c.txt
```

Expected: both FAIL.

- [ ] **Step 3: Order manual first and count it**

In `packages/gateway/src/glossary/glossary-store.ts`:

```ts
/**
 * Consolidated terms, authored ones first.
 *
 * `score` keeps its single meaning — strength of MINED evidence — so an
 * authored-but-unattested term legitimately scores 0. Ranking policy lives
 * here instead, which fixes three readers at once: list mode, the agent's
 * near-miss pool, and the extraction pass's near-miss pool. Without it an
 * authored term would sort last and be the first dropped from the 500-term
 * pool — the deliberately-authored term being the least likely to be
 * suggested.
 */
export function listConsolidated(db: Database, limit: number): GlossaryTerm[] {
  const rows = db
    .query(
      `SELECT * FROM glossary_term WHERE status = 'consolidated'
       ORDER BY (definition_source = 'manual') DESC, score DESC LIMIT ?`,
    )
    .all(limit) as Row[];
  return rows.map(toTerm);
}
```

and extend `countByStatus`:

```ts
export function countByStatus(db: Database): {
  total: number;
  pending: number;
  vetoed: number;
  manual: number;
} {
  const r = db
    .query(
      `SELECT
         SUM(CASE WHEN status = 'consolidated' THEN 1 ELSE 0 END) AS total,
         SUM(CASE WHEN status = 'pending'      THEN 1 ELSE 0 END) AS pending,
         SUM(CASE WHEN status = 'vetoed'       THEN 1 ELSE 0 END) AS vetoed,
         SUM(CASE WHEN definition_source = 'manual' THEN 1 ELSE 0 END) AS manual
       FROM glossary_term`,
    )
    .get() as {
    total: number | null;
    pending: number | null;
    vetoed: number | null;
    manual: number | null;
  } | null;
  // `manual` is a SUBSET of `total`, not a fourth disjoint bucket: `total`
  // counts consolidated rows, which now include authored ones. Mined count is
  // `total - manual`.
  return { total: r?.total ?? 0, pending: r?.pending ?? 0, vetoed: r?.vetoed ?? 0, manual: r?.manual ?? 0 };
}
```

In `packages/gateway/src/agents/_lib/glossary-types.ts`, extend `stats`:

```ts
  stats: {
    total: number;
    pending: number;
    vetoed: number;
    /** Subset of `total` — authored in `[glossary.terms]`. */
    manual: number;
    lastPassAt: number | null;
  };
```

- [ ] **Step 4: Label authored definitions in the renderer**

In `packages/gateway/src/agents/_lib/render.ts`, replace the single snippet branch at ~line 295:

```ts
      if (e.definitionSource === "snippet") {
        lines.push("- _Definition quoted verbatim from a source; no LLM configured._");
      } else if (e.definitionSource === "manual") {
        lines.push("- _Authored in `nimbus.toml`; not derived from indexed sources._");
      }
```

and in the list-mode loop further down, label authored entries so a 0-mention row is not confusing:

```ts
    for (const e of brief.entries) {
      const suffix = e.definitionSource === "manual" ? " — authored" : "";
      lines.push(`- **${e.term}** — ${String(e.docFreq)} mention(s)${suffix}`);
    }
```

- [ ] **Step 5: Correct the CLI preview and report skips**

In `packages/cli/src/commands/glossary.ts`, update the preview type and renderer:

```ts
type GlossaryPreviewLike = {
  stats: { total: number; pending: number; manual: number };
  entries: Array<{ term: string; definitionSource?: string | null }>;
};
```

Extend `isGlossaryPreviewLike` to require `typeof stats.manual === "number"` alongside the existing `total` / `pending` checks.

```ts
/**
 * A count says how much is lost; the sample says WHAT.
 *
 * Authored terms are NOT lost: rebuild truncates them and the same pass
 * re-reads them from `nimbus.toml` inside one transaction. Reporting them as
 * deletions would be a false claim, and after the manual-first ordering change
 * they head the sample — so the sample is filtered to mined terms too.
 */
export function renderRebuildPreview(
  counts: { total: number; pending: number; manual: number },
  sample: readonly string[],
): string {
  const mined = counts.total - counts.manual;
  const lines = [
    `${String(mined)} mined terms and ${String(counts.pending)} pending ` +
      "candidates would be deleted.",
  ];
  if (sample.length > 0) lines.push(`  ${sample.join(", ")}`);
  const remainder = mined - sample.length;
  if (remainder > 0) lines.push(`  ... and ${String(remainder)} more`);
  if (counts.manual > 0) {
    lines.push(
      `${String(counts.manual)} authored term(s) are re-read from nimbus.toml, not deleted.`,
    );
  }
  lines.push(
    "Rebuilding re-mines incrementally; the full glossary returns over subsequent passes.",
  );
  lines.push("Re-run with --yes to confirm.");
  return lines.join("\n");
}
```

In `readRebuildPreview`, filter the sample to mined entries before returning it:

```ts
      const sample = p.findings.entries
        .filter((e) => e.definitionSource !== "manual")
        .map((e) => e.term);
```

Add `manualSkipped` to `GlossaryPassSummaryLike`:

```ts
  manualSkipped?: Array<{ entry: string; reason: string }>;
```

and append to `renderPassOutcome`, before its `return lines;`:

```ts
  const skipped = s.manualSkipped ?? [];
  if (skipped.length > 0) {
    // Otherwise a rejected config entry is invisible: the user edits
    // nimbus.toml, sees a successful pass, and finds their term missing with
    // no explanation.
    lines.push(`Skipped ${String(skipped.length)} entry/entries in [glossary.terms]:`);
    for (const s2 of skipped.slice(0, 10)) {
      lines.push(`  ${s2.entry} — ${s2.reason}`);
    }
  }
```

- [ ] **Step 6: Run the tests to verify they pass**

```bash
bun test packages/gateway/src/glossary packages/gateway/src/agents > /tmp/t8g.txt 2>&1; echo "GW EXIT=$?"; tail -25 /tmp/t8g.txt
bun test packages/cli/src/commands/glossary.test.ts > /tmp/t8c.txt 2>&1; echo "CLI EXIT=$?"; tail -25 /tmp/t8c.txt
```

Expected: both `EXIT=0`.

- [ ] **Step 7: Red-prove the ordering test**

Revert `listConsolidated`'s `ORDER BY` to `score DESC` alone. Re-run — the ordering test must fail showing `Received: ["widget", "cdr"]`. A count-based assertion would have passed here; confirm the array assertion is what catches it. Restore, confirm green.

- [ ] **Step 8: Commit**

```bash
git add packages/gateway/src/glossary/glossary-store.ts \
        packages/gateway/src/glossary/glossary-store.test.ts \
        packages/gateway/src/agents/_lib/glossary-types.ts \
        packages/gateway/src/agents/_lib/render.ts \
        packages/gateway/src/agents/_lib/render.test.ts \
        packages/cli/src/commands/glossary.ts \
        packages/cli/src/commands/glossary.test.ts
git commit -F - <<'MSG'
feat(glossary): surface authored terms in the read path and CLI

listConsolidated orders authored terms first, which fixes three readers at
once — list mode and both near-miss pools. score keeps meaning "strength
of mined evidence", so an unattested authored term legitimately scores 0
and ranking policy lives at the read site instead of being smuggled into
the number.

The rebuild preview claimed authored terms would be deleted. They are
truncated and re-read from nimbus.toml inside one transaction, and after
the ordering change they HEAD the preview sample — so the wording and the
sample are both corrected. countByStatus.manual is a subset of total, not
a fourth bucket; mined count is total - manual.

--refresh now names config entries it rejected, which were otherwise
invisible.
MSG
```

---

## Task 9: Documentation

**Files:**

- Modify: `docs/CHANGELOG.md`, `docs/roadmap.md`, `docs/cli-reference.md`, `docs/architecture.md`, `CLAUDE.md`, `GEMINI.md`
- Modify: `docs/superpowers/specs/2026-07-30-nimbus-glossary-design.md` (§12 corrections)

- [ ] **Step 1: Correct the base spec's §12**

In `docs/superpowers/specs/2026-07-30-nimbus-glossary-design.md`, the last bullet of §12 ("No manual authoring or correction — deferred, with the seam named") is now shipped. Rewrite it to record delivery **and** correct two claims inside it that this slice made false:

- "manual rows are exempt from the reconciliation sweep" → exempt from **demotion and veto**; statistics are still swept, because full exemption would freeze `top_sources` forever.
- "Everything else is additive: no invariant and no read path changes" → the read path **does** change: `listConsolidated` gains manual-first ordering and both `DefinitionSource` unions widen.

Also qualify the near-miss bullet: authored terms now sort ahead of mined ones and therefore cannot be the dropped tail.

- [ ] **Step 2: Update the delivery log and status lines**

`docs/CHANGELOG.md` — a dated entry at the top of "Post-Phase-6 deliveries" following the house style (what shipped, why, what was rejected).

`CLAUDE.md` and `GEMINI.md` — both carry `schema V45` in the Status paragraph; change to `V46`. Do not add a delivery line to either; the CHANGELOG is the canonical log.

`docs/architecture.md` — the schema table gains the V46 row.

`docs/roadmap.md` — tick the Wave 5 manual-authoring item.

`docs/cli-reference.md` — document `[glossary.terms]` / `[glossary.synonyms]` and the edit-then-`--refresh` loop under `nimbus glossary`. State explicitly that entries must sit under those two flat headers: `[glossary]` with a dotted `terms.CDR = "…"` key is valid TOML that this parser does not read. It is now reported rather than ignored (Task 4), but the documentation must not leave a reader to discover that from a warning.

- [ ] **Step 3: Grep for every citation, then read around the hits**

```bash
grep -rn "definition_source\|'llm','snippet'\|V45\|listConsolidated\|definitionSource" docs/ CLAUDE.md GEMINI.md > /tmp/t9grep.txt 2>&1; echo "EXIT=$?"; cat /tmp/t9grep.txt
```

Read the surrounding prose at each hit, not only the matched line. Three of the ten false doc claims corrected in this feature's history were found only that way.

- [ ] **Step 4: Lint the docs by explicit path**

```bash
bunx markdownlint-cli2 "docs/**/*.md" "*.md" > /tmp/t9md.txt 2>&1; echo "MD EXIT=$?"; tail -10 /tmp/t9md.txt
bunx lychee --no-progress --config lychee.toml "docs/**/*.md" "*.md" > /tmp/t9ly.txt 2>&1; echo "LYCHEE EXIT=$?"; tail -10 /tmp/t9ly.txt
```

Expected: both `EXIT=0`. A pre-existing broken link elsewhere in the branch fails your PR, so fix what you find.

- [ ] **Step 5: Commit**

```bash
git add docs CLAUDE.md GEMINI.md
git commit -F - <<'MSG'
docs(glossary): record manual authoring and correct the base spec

The base spec's §12 deferral bullet is now shipped, and two claims inside
it were made false by the implementation: manual rows are exempt from
DEMOTION and veto rather than from the sweep entirely (full exemption
would freeze top_sources), and the read path does change — manual-first
ordering plus both widened DefinitionSource unions.
MSG
```

---

## Task 10: Full verification before the PR

- [ ] **Step 1: Static gates**

```bash
bunx biome check packages scripts > /tmp/v1.txt 2>&1; echo "BIOME EXIT=$?"; tail -20 /tmp/v1.txt
bunx tsc --noEmit -p packages/gateway/tsconfig.json > /tmp/v2.txt 2>&1; echo "TSC-GW EXIT=$?"; tail -20 /tmp/v2.txt
bunx tsc --noEmit -p packages/cli/tsconfig.json > /tmp/v3.txt 2>&1; echo "TSC-CLI EXIT=$?"; tail -20 /tmp/v3.txt
```

All three must print `EXIT=0`. Remember `bun run lint` reports "Checked 0 files" here and exits 0 — it is not evidence.

- [ ] **Step 2: `preflight:fast`**

```bash
bun run preflight:fast > /tmp/v4.txt 2>&1; echo "PREFLIGHT EXIT=$?"; tail -40 /tmp/v4.txt
```

Expected `EXIT=0`. If `audit:any` flags a `any` inside one of the new docstrings, rephrase the prose — it counts occurrences inside `/** */` blocks containing a backtick.

- [ ] **Step 3: Affected suites**

```bash
bun test packages/gateway/src/config packages/gateway/src/glossary packages/gateway/src/agents packages/gateway/src/index > /tmp/v5.txt 2>&1; echo "GW EXIT=$?"; tail -30 /tmp/v5.txt
bun test packages/cli/src/commands/glossary.test.ts > /tmp/v6.txt 2>&1; echo "CLI EXIT=$?"; tail -20 /tmp/v6.txt
bun test packages/gateway/test/e2e/scenarios/glossary.e2e.test.ts > /tmp/v7.txt 2>&1; echo "E2E EXIT=$?"; tail -20 /tmp/v7.txt
```

All must print `EXIT=0`.

- [ ] **Step 4: Docker coverage floor (Linux-authoritative)**

New source files landed under `packages/gateway/src`, so this is required, not optional.

```bash
bash scripts/coverage-floor/reseed-docker.sh > /tmp/v8.txt 2>&1; echo "COVERAGE EXIT=$?"; tail -40 /tmp/v8.txt
```

Sanity-check the file count in the output: **~985 source files means a real run; ~199 means broken tooling**, not a result. Do not mount the repo with `-v repo:/w` — that yields garbage numbers.

If a new file is below the 80% line/branch floor, **write tests**. Do not add an exclusion; if a branch looks genuinely unreachable, restructure it away or escalate rather than excluding unilaterally.

- [ ] **Step 5: Confirm no invariant drift**

```bash
bun test packages/gateway/src/security-invariants.test.ts > /tmp/v9.txt 2>&1; echo "INV EXIT=$?"; tail -20 /tmp/v9.txt
bun scripts/structure-audit/check-nimbus-invariants.ts > /tmp/v10.txt 2>&1; echo "STATIC EXIT=$?"; tail -20 /tmp/v10.txt
```

Expected `EXIT=0` for both. This feature adds no invariant; these confirm none was accidentally weakened (notably that every new write went through `dbRun` / `dbExec`, per D12).

- [ ] **Step 6: Open the PR**

The **PR title and body become the squash commit** — local commit messages are discarded. Title must carry the conventional-commit type, since release-please parses it:

```text
feat(glossary): author and correct terms in nimbus.toml
```

Body: the design decisions (desired-state removal with demote-not-delete, the `loaded` fail-safe, the sweep narrowing, manual-first ordering, the rebuild transaction), plus the parser repair and its blast radius. Do **not** include a bare `Release-As:` line.

---

## Notes for the implementer

**The eight false-green shapes seen in this feature's history.** Each red-prove step above targets one. When adding any test of your own, check it against these: an outer transaction masking the bug; a count-only assertion on an ordered collection; a fixture that cannot separate two ANDed predicates; an assertion whose row never existed; a symmetric seed making a ratio test filter-agnostic; a red-prove that hung instead of asserting; a guard condition that was provably unsatisfiable; and a piped command hiding a non-zero exit code.

**IDE diagnostics in this repo were wrong ~25 times in one recent session, and right once.** Check each on its own merits against a real `tsc` or `bun test` run, then move on.

**`LIMIT -1` in SQLite means UNLIMITED, not "no rows."** Relevant if you touch any batch-selection query.

**`COUNT(*)` never returns NULL** so it needs no `?? 0`, unlike `SUM(CASE …)` — whose fallback in `countByStatus` genuinely is reachable. Do not copy one pattern to the other.
