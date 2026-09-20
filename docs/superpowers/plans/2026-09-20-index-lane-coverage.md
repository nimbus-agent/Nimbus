# Index Lane Coverage Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Catch, before merge, any production query filtering on an `item.type` or `metadata.<key>` that no shipped connector writes.

**Architecture:** A table-aware static census extracts what queries READ and what connectors WRITE, a typed coverage map classifies every read, and the census becomes a blocking gate the moment a read has no entry. Canaries confirm the lanes where "returns rows" is the claim worth pinning.

**Tech Stack:** Bun 1.2+, TypeScript strict, Biome. New scanner joins `scripts/structure-audit/`; new map lives in `packages/gateway/src/index/`.

**Spec:** [`docs/superpowers/specs/2026-09-20-index-lane-coverage-design.md`](../specs/2026-09-20-index-lane-coverage-design.md) — read it first. The four confirmed bugs in §1 are the acceptance target.

## Global Constraints

- TypeScript strict; **no `any`** — `unknown` for external data (Non-Negotiable 7).
- Every new audit rule is a pure `check<Name>(files: readonly FileEntry[]): Violation[]` — no I/O, so it is unit-testable. Match `check-nimbus-invariants.ts`.
- **Scope is `item` only.** `graph_entity` and `graph_relation` reads are censused for the artifact but never gated in v1 (spec §5).
- Writer corpus is `connectors/**` + `deployment/annotate.ts`. **Excludes `demo/`, `perf/`, `agents/`, `test/fixtures/`** — this exclusion is the gate's correctness and no scanner validates it (spec §2.2).
- Three tables carry a bare `type` column. **Never compare a type literal without knowing its table** (spec §2.1).
- A check that cannot fail must not report success. Every rule gets an anti-vacuity case, matching `check-nimbus-invariants.test.ts:1270`.
- `bun run preflight:fast` before any hand-back; `bun run audit:invariants` must exit 0.

---

## File Structure

**PR 1 — census (report-only, exits 0):**
- Create `scripts/structure-audit/lane-census/sql-literals.ts` — find SQL string literals, preprocess `${…}`.
- Create `scripts/structure-audit/lane-census/alias-binding.ts` — `FROM`/`JOIN`/CTE → alias→table map.
- Create `scripts/structure-audit/lane-census/read-sites.ts` — emit read triples from bound literals.
- Create `scripts/structure-audit/lane-census/writer-emissions.ts` — what `connectors/**` writes.
- Create `scripts/structure-audit/check-index-lane-coverage.ts` — assembles the census, writes the artifact.
- Create `docs/structure-audit/index-lane-census.json` — the artifact (generated, committed).

**PR 2 — map + gate:**
- Create `packages/gateway/src/index/lane-coverage.ts` — the typed map.
- Modify `packages/gateway/src/agents/_lib/gap-notes.ts` — add `detectMissingItemType`.
- Modify `scripts/structure-audit/check-index-lane-coverage.ts` — gate mode + anti-stale rules.
- Modify `packages/gateway/src/connectors/connector-sync-test-helpers.ts` — relative-timestamp fixtures.

Each file has one responsibility and is independently testable; `check-index-lane-coverage.ts` only composes.

---

# PR 1 — The census

### Task 1.1: SQL literal extraction and interpolation preprocessing

**Files:**
- Create: `scripts/structure-audit/lane-census/sql-literals.ts`
- Test: `scripts/structure-audit/lane-census/sql-literals.test.ts`

**Interfaces:**
- Produces: `export type SqlLiteral = { readonly sql: string; readonly line: number }` and `export function extractSqlLiterals(contents: string): readonly SqlLiteral[]`.
- `sql` has every `${…}` replaced by the identifier `__INTERP__`; `line` is 1-indexed at the literal's start.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, test } from "bun:test";
import { extractSqlLiterals } from "./sql-literals.ts";

describe("extractSqlLiterals", () => {
  test("finds a template literal and neutralises interpolation", () => {
    const src = [
      "const rows = db.query(`",
      "  SELECT id FROM item",
      "  WHERE service IN (${placeholders}) AND type = 'ci_run'",
      "`).all();",
    ].join("\n");
    const out = extractSqlLiterals(src);
    expect(out).toHaveLength(1);
    expect(out[0]?.sql).toContain("__INTERP__");
    expect(out[0]?.sql).not.toContain("${");
    expect(out[0]?.line).toBe(1);
  });

  test("ignores a non-SQL template literal", () => {
    expect(extractSqlLiterals("const msg = `hello ${name}`;")).toHaveLength(0);
  });

  test("returns nothing for empty input", () => {
    expect(extractSqlLiterals("")).toHaveLength(0);
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `bun test scripts/structure-audit/lane-census/sql-literals.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

A literal counts as SQL when it contains `SELECT` and `FROM` (case-insensitive) — narrow on purpose, since a false positive costs a spurious census row.

```ts
const SQL_SHAPE = /\bselect\b[\s\S]*\bfrom\b/i;
const INTERP = /\$\{[^}]*\}/g;

export type SqlLiteral = { readonly sql: string; readonly line: number };

export function extractSqlLiterals(contents: string): readonly SqlLiteral[] {
  const out: SqlLiteral[] = [];
  for (let i = 0; i < contents.length; i++) {
    if (contents[i] !== "`") continue;
    const end = findTemplateEnd(contents, i);
    if (end === -1) break;
    const raw = contents.slice(i + 1, end);
    if (SQL_SHAPE.test(raw)) {
      out.push({ sql: raw.replace(INTERP, "__INTERP__"), line: lineAt(contents, i) });
    }
    i = end;
  }
  return out;
}
```

Write `findTemplateEnd` to skip `\\` escapes and to track nested `${ … }` depth so a backtick inside an interpolation does not end the literal. Write `lineAt` as a newline count up to the offset.

- [ ] **Step 4: Run tests**

Run: `bun test scripts/structure-audit/lane-census/sql-literals.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add scripts/structure-audit/lane-census/sql-literals.ts scripts/structure-audit/lane-census/sql-literals.test.ts
git commit -F <message-file>
```

---

### Task 1.2: Alias binding, including CTEs

**Files:**
- Create: `scripts/structure-audit/lane-census/alias-binding.ts`
- Test: `scripts/structure-audit/lane-census/alias-binding.test.ts`

**Interfaces:**
- Consumes: `SqlLiteral.sql` from Task 1.1.
- Produces: `export type TableName = "item" | "graph_entity" | "graph_relation"`, `export function bindAliases(sql: string): ReadonlyMap<string, TableName>`.
- The map includes the bare table name as its own key (`item` → `item`), every alias, and every CTE name resolved transitively.

- [ ] **Step 1: Write the failing test** — the CTE case is the one `preflight.ts` needs.

```ts
import { describe, expect, test } from "bun:test";
import { bindAliases } from "./alias-binding.ts";

describe("bindAliases", () => {
  test("binds FROM and JOIN aliases", () => {
    const m = bindAliases("SELECT 1 FROM item i JOIN graph_entity e ON e.id = i.id");
    expect(m.get("i")).toBe("item");
    expect(m.get("e")).toBe("graph_entity");
    expect(m.get("item")).toBe("item");
  });

  test("resolves a CTE to the table it selects from", () => {
    const sql = "WITH ranked AS (SELECT id, metadata FROM item WHERE type = 'ci_run') SELECT * FROM ranked WHERE rn = 1";
    expect(bindAliases(sql).get("ranked")).toBe("item");
  });

  test("ignores an unknown table", () => {
    expect(bindAliases("SELECT 1 FROM sqlite_master m").get("m")).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `bun test scripts/structure-audit/lane-census/alias-binding.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```ts
export type TableName = "item" | "graph_entity" | "graph_relation";
const TABLES: ReadonlySet<string> = new Set(["item", "graph_entity", "graph_relation"]);
const SOURCE = /\b(?:from|join)\s+([a-z_][a-z0-9_]*)(?:\s+(?:as\s+)?([a-z_][a-z0-9_]*))?/gi;
const CTE = /\b([a-z_][a-z0-9_]*)\s+as\s*\(/gi;
```

Two passes. First, walk `CTE` matches; for each, take the balanced-paren body and recursively `bindAliases` it, mapping the CTE name to the first known table that body resolves to. Second, walk `SOURCE` over the whole string, skipping any name already bound as a CTE, and map both the table name and its alias. Reserved words (`as`, `on`, `where`, `select`, `group`, `order`, `left`, `inner`) must never be treated as an alias.

- [ ] **Step 4: Run tests**

Run: `bun test scripts/structure-audit/lane-census/alias-binding.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

---

### Task 1.3: Read-site extraction

**Files:**
- Create: `scripts/structure-audit/lane-census/read-sites.ts`
- Test: `scripts/structure-audit/lane-census/read-sites.test.ts`

**Interfaces:**
- Consumes: `extractSqlLiterals` (1.1), `bindAliases` (1.2).
- Produces:

```ts
export type ReadTriple = {
  readonly table: TableName;
  readonly kind: "type" | "metadata-key";
  readonly value: string;
  readonly file: string;
  readonly line: number;
};
export function extractReadTriples(file: string, contents: string): readonly ReadTriple[];
```

- `line` is the literal's start line plus the offset within it, so a triple points at the predicate, not the query.

- [ ] **Step 1: Write the failing test** — including the table-awareness case that is the whole point.

```ts
import { describe, expect, test } from "bun:test";
import { extractReadTriples } from "./read-sites.ts";

describe("extractReadTriples", () => {
  test("binds a type literal to item, not to another table", () => {
    const src = "db.query(`SELECT id FROM item i WHERE i.type = 'commit'`);";
    const out = extractReadTriples("a.ts", src);
    expect(out).toEqual([
      { table: "item", kind: "type", value: "commit", file: "a.ts", line: 1 },
    ]);
  });

  test("the same literal on graph_entity is a DIFFERENT triple", () => {
    const src = "db.query(`SELECT id FROM graph_entity e WHERE e.type = 'commit'`);";
    expect(extractReadTriples("b.ts", src)[0]?.table).toBe("graph_entity");
  });

  test("extracts a metadata key", () => {
    const src = "db.query(`SELECT 1 FROM item WHERE json_extract(metadata, '$.conclusion') = ?`);";
    const out = extractReadTriples("c.ts", src);
    expect(out).toContainEqual(
      expect.objectContaining({ table: "item", kind: "metadata-key", value: "conclusion" }),
    );
  });

  test("returns nothing for a file with no SQL", () => {
    expect(extractReadTriples("d.ts", "export const x = 1;")).toHaveLength(0);
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `bun test scripts/structure-audit/lane-census/read-sites.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```ts
const TYPE_CMP = /(?:\b([a-z_][a-z0-9_]*)\.)?\btype\s*=\s*'([a-z0-9_]+)'/gi;
const META_KEY = /json_extract\(\s*(?:([a-z_][a-z0-9_]*)\.)?metadata\s*,\s*'\$\.([A-Za-z0-9_]+)'/gi;
```

For each literal, bind aliases once. An unqualified `type`/`metadata` resolves to the single bound table when exactly one is bound, and is **skipped** when more than one is — recording it as ambiguous would be worse than omitting it, and the ambiguous count goes in the artifact. A qualified name that binds to nothing is skipped the same way.

- [ ] **Step 4: Run tests**

Run: `bun test scripts/structure-audit/lane-census/read-sites.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

---

### Task 1.4: Same-file helper follow and JS-side metadata reads

**Files:**
- Modify: `scripts/structure-audit/lane-census/read-sites.ts`
- Modify: `scripts/structure-audit/lane-census/read-sites.test.ts`

**Interfaces:**
- `extractReadTriples` gains JS-side triples. Signature unchanged.
- Produces: `export const METADATA_READER_HELPERS: readonly string[]` — the cross-file manifest, initially `["repoLikeMatchesUrn", "repoMetadataMatchesUrn"]`.

**Why both members exist:** `dora.ts:60`'s `repoLikeMatchesUrn` is how `repo` hides from a per-call-site window; `metrics/service-identity.ts:68`'s `repoMetadataMatchesUrn` is the second binder with the same shape, found during feasibility and **not yet verified end to end** (spec §1).

- [ ] **Step 1: Write the failing test**

```ts
test("picks up a JS-side metadata read", () => {
  const src = [
    "const meta = JSON.parse(row.metadata) as Record<string, unknown>;",
    'if (meta["conclusion"] !== "success") return null;',
  ].join("\n");
  const out = extractReadTriples("e.ts", src);
  expect(out).toContainEqual(
    expect.objectContaining({ table: "item", kind: "metadata-key", value: "conclusion" }),
  );
});

test("a named helper contributes the keys it reads", () => {
  const src = [
    "function repoLikeMatchesUrn(metadata: Record<string, unknown>) {",
    '  return metadata["repo"] === "x" || metadata["project"] === "y";',
    "}",
  ].join("\n");
  const values = extractReadTriples("f.ts", src).map((t) => t.value);
  expect(values).toContain("repo");
  expect(values).toContain("project");
});
```

- [ ] **Step 2: Run and watch it fail**

Run: `bun test scripts/structure-audit/lane-census/read-sites.test.ts`
Expected: FAIL on the two new cases.

- [ ] **Step 3: Implement**

Add `/\bmeta(?:data)?\[\s*"([A-Za-z0-9_]+)"\s*\]/g` over the comment-stripped contents, attributed to `item` (only `item` rows carry a JSON `metadata` column read this way in v1). Run the same scan inside the body of any function whose name is in `METADATA_READER_HELPERS`, so a cross-file helper contributes at its definition site.

**Do not** try to resolve which call site reaches which helper — that is a call graph, and the manifest exists precisely so the extractor does not need one.

- [ ] **Step 4: Run tests**

Run: `bun test scripts/structure-audit/lane-census/read-sites.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

---

### Task 1.5: Writer emissions

**Files:**
- Create: `scripts/structure-audit/lane-census/writer-emissions.ts`
- Test: `scripts/structure-audit/lane-census/writer-emissions.test.ts`

**Interfaces:**
- Produces:

```ts
export type WriterEmission = {
  readonly service: string;
  readonly itemType: string;
  readonly metadataKeys: readonly string[];
  readonly file: string;
  readonly line: number;
};
export function extractWriterEmissions(file: string, contents: string): readonly WriterEmission[];
export const WRITER_INCLUDE: readonly string[];  // ["packages/gateway/src/connectors/", "packages/gateway/src/deployment/annotate.ts"]
export const WRITER_EXCLUDE: readonly string[];  // ["/demo/", "/perf/", "/agents/", "/test/fixtures/"]
```

- [ ] **Step 1: Write the failing test** — the exclusion case is load-bearing (spec §2.2).

```ts
import { describe, expect, test } from "bun:test";
import { extractWriterEmissions, WRITER_EXCLUDE } from "./writer-emissions.ts";

describe("extractWriterEmissions", () => {
  test("reads a row literal with an inline metadata object", () => {
    const src = [
      "ctx.upsertItem({",
      '  service: "github_actions",',
      '  type: "ci_run",',
      "  metadata: { workflowName: name, conclusion, headSha },",
      "});",
    ].join("\n");
    const out = extractWriterEmissions("x-sync.ts", src);
    expect(out[0]?.service).toBe("github_actions");
    expect(out[0]?.itemType).toBe("ci_run");
    expect([...(out[0]?.metadataKeys ?? [])].sort()).toEqual(["conclusion", "headSha", "workflowName"]);
  });

  test("resolves metadata assigned to a local const", () => {
    const src = [
      'const meta = { jobName: j, result: r };',
      'ctx.upsertItem({ service: "jenkins", type: "ci_run", metadata: meta });',
    ].join("\n");
    expect([...(extractWriterEmissions("j.ts", src)[0]?.metadataKeys ?? [])].sort()).toEqual(["jobName", "result"]);
  });

  test("the demo corpus is excluded by path", () => {
    expect(WRITER_EXCLUDE.some((p) => "packages/gateway/src/demo/corpus/acme.ts".includes(p))).toBe(true);
  });
});
```

- [ ] **Step 2: Run and watch it fail**

Run: `bun test scripts/structure-audit/lane-census/writer-emissions.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

Find object literals carrying both `service:` and `type:`. Resolve each value in this order, stopping at the first hit: a string literal; a module-level `const NAME = "…" as const` in the same file; a ternary of two string literals (emit **both**); a local `const` holding either. Resolve `metadata:` to an object literal's top-level keys, following one hop when it is an identifier or a call whose callee is defined in the same file.

Record anything unresolved as `itemType: "__UNRESOLVED__"` rather than dropping it — an unresolved writer must be visible in the artifact, not silently absent. Expected: exactly one, `_lib/item-builder.ts` (dead code, no production callers).

- [ ] **Step 4: Run tests**

Run: `bun test scripts/structure-audit/lane-census/writer-emissions.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

---

### Task 1.6: Census assembly and artifact

**Files:**
- Create: `scripts/structure-audit/check-index-lane-coverage.ts`
- Test: `scripts/structure-audit/check-index-lane-coverage.test.ts`
- Create (generated): `docs/structure-audit/index-lane-census.json`

**Interfaces:**
- Consumes: `extractReadTriples` (1.3/1.4), `extractWriterEmissions` (1.5).
- Produces: `export function collectLaneCensus(files: readonly FileEntry[]): LaneCensus` where

```ts
export type LaneCensus = {
  readonly reads: readonly ReadTriple[];
  readonly writes: readonly WriterEmission[];
  readonly unmatchedItemReads: readonly ReadTriple[];  // item reads no writer satisfies
  readonly ambiguousReadCount: number;
};
```

`unmatchedItemReads` is the payload: a `type` triple with no writer emitting that type, or a `metadata-key` triple no writer emits for any type read alongside it.

- [ ] **Step 1: Write the failing test**

```ts
test("an item type no writer emits lands in unmatchedItemReads", () => {
  const census = collectLaneCensus([
    { relPath: "packages/gateway/src/agents/expert.ts", contents: "db.query(`SELECT 1 FROM item i WHERE i.type = 'commit'`);" },
    { relPath: "packages/gateway/src/connectors/fs-sync.ts", contents: 'ctx.upsertItem({ service: "filesystem", type: "git_commit", metadata: {} });' },
  ]);
  expect(census.unmatchedItemReads.map((r) => r.value)).toContain("commit");
});

test("a graph_entity read of the same literal does NOT satisfy the item read", () => {
  const census = collectLaneCensus([
    { relPath: "packages/gateway/src/agents/expert.ts", contents: "db.query(`SELECT 1 FROM item i WHERE i.type = 'commit'`);" },
    { relPath: "packages/gateway/src/graph/graph-populator.ts", contents: 'upsertGraphEntity({ type: "commit" });' },
  ]);
  expect(census.unmatchedItemReads.map((r) => r.value)).toContain("commit");
});

test("empty input yields an empty census, not a crash", () => {
  const census = collectLaneCensus([]);
  expect(census.reads).toHaveLength(0);
  expect(census.unmatchedItemReads).toHaveLength(0);
});
```

- [ ] **Step 2: Run and watch it fail**

Run: `bun test scripts/structure-audit/check-index-lane-coverage.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement + wire the CLI**

`collectLaneCensus` filters writers by `WRITER_INCLUDE`/`WRITER_EXCLUDE`, reads from everything under `packages/gateway/src/**` minus `*.test.ts`. The entry point mirrors `collectDbRunCensus`: **always exits 0**, writes the JSON artifact via `auditOutputPath`, prints a one-line summary.

Add to `package.json`: `"audit:lane-census": "bun scripts/structure-audit/check-index-lane-coverage.ts"`.

- [ ] **Step 4: Run tests and generate the artifact**

Run: `bun test scripts/structure-audit/check-index-lane-coverage.test.ts && bun run audit:lane-census`
Expected: PASS (3 tests); artifact written; exit 0.

- [ ] **Step 5: Commit** — include the generated artifact.

---

### Task 1.7: Acceptance — the census must reproduce the four bugs

**Files:**
- Create: `scripts/structure-audit/check-index-lane-coverage.acceptance.test.ts`

This is the task that decides whether the census is real. It runs against **the actual repo tree**, not fixtures.

- [ ] **Step 1: Write the test**

```ts
import { describe, expect, test } from "bun:test";
import { collectLaneCensus } from "./check-index-lane-coverage.ts";
import { readAllSourceFiles } from "./lane-census/read-all.ts";

describe("lane census over the real tree", () => {
  const census = collectLaneCensus(await readAllSourceFiles());
  const unmatched = (v: string) => census.unmatchedItemReads.some((r) => r.value === v);

  test("expert.ts's dead commit lane is unmatched", () => expect(unmatched("commit")).toBe(true));
  test("preflight's workflow_name is unmatched", () => expect(unmatched("workflow_name")).toBe(true));
  test("preflight's branch is unmatched", () => expect(unmatched("branch")).toBe(true));
  test("premortem's opened_at_ms is unmatched on PR items", () => expect(unmatched("opened_at_ms")).toBe(true));

  test("the demo corpus does not satisfy DORA's repo read", () => {
    expect(census.writes.some((w) => w.file.includes("/demo/"))).toBe(false);
  });

  test("ambiguity is disclosed, not hidden", () => {
    expect(census.ambiguousReadCount).toBeGreaterThanOrEqual(0);
  });
});
```

- [ ] **Step 2: Run it**

Run: `bun test scripts/structure-audit/check-index-lane-coverage.acceptance.test.ts`
Expected: PASS. **If any of the four fails, the extractor is wrong — fix the extractor, never the assertion.**

- [ ] **Step 3: Record the numbers in the report**

State in your hand-back: total reads, total writes, `unmatchedItemReads.length`, `ambiguousReadCount`. The unmatched count is the blast radius PR 2 has to classify.

- [ ] **Step 4: Run the full gate set**

Run: `bun run preflight:fast`
Expected: all gates green.

- [ ] **Step 5: Commit**

---

### Task 1.8: PR 1 — docs and open

**Files:**
- Modify: `docs/CHANGELOG.md` (dated bullet)
- Modify: `docs/roadmap.md` (B4 row: census landed, gate pending)

- [ ] **Step 1: Write the CHANGELOG bullet** naming the four bugs the census reproduces and stating that it is report-only.
- [ ] **Step 2:** Confirm `docs/superpowers/` is absent from the diff: `git diff --name-only origin/main...HEAD | grep superpowers` must be empty. **Strip the spec and review files before opening the PR** — they live on the branch during development and never land on `main`.
- [ ] **Step 3:** `bun run preflight`.
- [ ] **Step 4:** Open the PR. Title: `feat(audit): index lane census (report-only)`.

---

# PR 2 — The map and the gate

### Task 2.1: The typed coverage map

**Files:**
- Create: `packages/gateway/src/index/lane-coverage.ts`
- Test: `packages/gateway/src/index/lane-coverage.test.ts`

**Interfaces:** exactly as spec §4.2:

```ts
export type LaneStatus =
  | { readonly kind: "canaried"; readonly canaryTestFile: string; readonly canaryTestName: string }
  | { readonly kind: "disclosed"; readonly gapProbe: string }
  | { readonly kind: "known-dead"; readonly reason: string; readonly issue: string };

export type LaneCoverageEntry = {
  readonly service: string;
  readonly itemType: string;
  readonly requiredMetadataKeys: readonly string[];
  readonly servicesReached?: readonly string[];
  readonly status: LaneStatus;
};

export const INDEX_LANE_COVERAGE: readonly LaneCoverageEntry[];
```

- [ ] **Step 1: Write the failing test**

```ts
test("every known-dead entry carries a reason and an issue", () => {
  for (const e of INDEX_LANE_COVERAGE) {
    if (e.status.kind !== "known-dead") continue;
    expect(e.status.reason.length).toBeGreaterThan(0);
    expect(e.status.issue).toMatch(/#\d+|https:\/\/github\.com\//);
  }
});

test("no duplicate service:type pairs", () => {
  const keys = INDEX_LANE_COVERAGE.map((e) => `${e.service}:${e.itemType}`);
  expect(new Set(keys).size).toBe(keys.length);
});
```

- [ ] **Step 2: Run and watch it fail.** Expected: module not found.
- [ ] **Step 3: Implement** the types and an initial map containing only the four confirmed bugs as `known-dead`, each against a real tracking issue in `nimbus-agent/Nimbus`.
- [ ] **Step 4: Run tests.** Expected: PASS.
- [ ] **Step 5: Commit.**

---

### Task 2.2: `detectMissingItemType`

**Files:**
- Modify: `packages/gateway/src/agents/_lib/gap-notes.ts`
- Modify: `packages/gateway/src/agents/_lib/gap-notes.test.ts`

**Interfaces:** per spec §4.3 —

```ts
export type ItemTypeGap =
  | { readonly kind: "missing_connector"; readonly service: string }
  | { readonly kind: "empty_lane"; readonly service: string; readonly itemType: string };

export function detectMissingItemType(db: Database, service: string, itemType: string): GapNote | null;
```

- [ ] **Step 1: Write the failing test** covering all three outcomes against a real in-memory SQLite built from the repo's own DDL: no `sync_state` row → `missing_connector`; `sync_state` present + zero matching items → `empty_lane`; items present → `null`.
- [ ] **Step 2: Run and watch it fail.**
- [ ] **Step 3: Implement.** Follow `detectMissingEntityType`'s existing shape and add a remediation string to the frozen map beside `ENTITY_TYPE_REMEDIATIONS`. **Do not** split `empty_lane` further — the index cannot distinguish "unsupported type" from "user genuinely has none", and a probe that guessed would be the overclaim this whole initiative exists to catch.
- [ ] **Step 4: Run tests.**
- [ ] **Step 5: Commit.**

---

### Task 2.3: Gate mode and the three anti-stale rules

**Files:**
- Modify: `scripts/structure-audit/check-index-lane-coverage.ts`
- Modify: `scripts/structure-audit/check-index-lane-coverage.test.ts`
- Modify: `scripts/structure-audit/check-nimbus-invariants.test.ts` (ratchet)

**Interfaces:**
- Produces: `export function checkLaneCoverage(census: LaneCensus, map: readonly LaneCoverageEntry[]): Violation[]`.

- [ ] **Step 1: Write the failing tests** — rule 1 is the one that matters most:

```ts
test("an unclassified item read is a violation", () => { /* census has a read, map is empty → 1 violation */ });

test("a known-dead lane whose writer NOW emits the key is a violation", () => {
  // map: github_actions:ci_run known-dead, requiredMetadataKeys ["repo"]
  // census: a writer emitting repo for github_actions:ci_run
  // → violation naming reclassification
});

test("a fully classified census yields zero violations", () => { /* anti-vacuity */ });
```

- [ ] **Step 2: Run and watch them fail.**
- [ ] **Step 3: Implement** the three rules from spec §4.2: unclassified read → violation; `known-dead` + writer now emits → violation; `reason`/`issue` format. Add a descending ratchet on the `known-dead` count in `check-nimbus-invariants.test.ts`. Wire into `check-nimbus-invariants.ts`'s `run()` alongside the D-rules, emitting `::error file=…,line=…::`.
- [ ] **Step 4: Run** `bun test scripts/structure-audit/ && bun run audit:invariants`. Expected: green with the four bugs classified.
- [ ] **Step 5: Commit.**

---

### Task 2.4: Canary harness — relative timestamps

**Files:**
- Modify: `packages/gateway/src/connectors/connector-sync-test-helpers.ts`
- Modify: its colocated test

**Interfaces:**
- Produces: `export function relativeFixtureTime(offsetMs: number): string` — an ISO string at `Date.now() + offsetMs`, so a fixture is always inside the query's window.

- [ ] **Step 1: Write the failing test** proving a fixture built through the helper still falls inside a 7-day window when the clock is moved forward a year (inject `now`, do not touch the real clock).
- [ ] **Step 2: Run and watch it fail.**
- [ ] **Step 3: Implement.** Document at the definition **why**: a fixed-date fixture fails as though the lane were dead, which poisons the exact signal this gate produces.
- [ ] **Step 4: Run tests.**
- [ ] **Step 5: Commit.**

---

### Task 2.5: First canaries — the DORA lane

**Files:**
- Create: `packages/gateway/src/metrics/dora.canary.test.ts`

- [ ] **Step 1: Write the canary** — drive the **real** `github_actions` syncable against a stubbed `fetch` returning a recorded response, into a real SQLite index, then run `selectDeploys` and assert it returns ≥1 row **and** that `conclusion` and the repo binding are non-null. It will FAIL today; that is correct — it is the bug.
- [ ] **Step 2: Run it.** Expected: FAIL, with the failure naming the missing `repo` key.
- [ ] **Step 3: Mark it `.todo`** with a comment linking the tracking issue, so PR 2 stays green while the bug is classified `known-dead`. **Do not fix the connector here** — that is Phase 3, one PR per bug, so each fix is reviewable on its own.
- [ ] **Step 4: Run** `bun test packages/gateway/src/metrics/`.
- [ ] **Step 5: Commit.**

---

### Task 2.6: PR 2 — docs, gates, open

**Files:**
- Modify: `docs/CHANGELOG.md`, `docs/roadmap.md` (tick B4's census+gate half), `docs/architecture.md` (the map's location and what it classifies)

- [ ] **Step 1:** Docs, naming the four `known-dead` entries and their issues.
- [ ] **Step 2:** Confirm `docs/superpowers/` is absent from the diff; strip spec and review.
- [ ] **Step 3:** `bun run preflight`.
- [ ] **Step 4:** Open the PR. Title: `feat(audit): gate index lane coverage`.

---

## Phase 3 — not in this plan

One PR per confirmed bug, each adding its canary and reclassifying its entry from `known-dead`. Sequenced after the census reports the true blast radius, because the count of unclassified reads from Task 1.7 is what sizes that work — planning it now would be guessing.

---

## Self-review record (planning-time)

- **Spec coverage:** §4.1 census → Tasks 1.1–1.6; §4.2 map + anti-stale → 2.1, 2.3; §4.2.1 cross-service → 1.3 (ambiguity disclosure) + 2.1 (`servicesReached`); §4.2.2 extractor bounds → 1.4, 1.5; §4.3 probe → 2.2; §4.4 canaries → 2.4, 2.5; §5 item-only scope → Global Constraints + 1.6; §5.1 rollout → the PR split; §7 acceptance 1–5 → Task 1.7, acceptance 6–8 → 1.7 and 2.3.
- **Placeholder scan:** every code step carries real code or a named algorithm with its regexes; no "add error handling", no "similar to Task N".
- **Type consistency:** `TableName` (1.2) is used unchanged by `ReadTriple` (1.3); `ReadTriple`/`WriterEmission` feed `LaneCensus` (1.6) and `checkLaneCoverage` (2.3); `LaneCoverageEntry` (2.1) is the only shape 2.3 reads. `ItemTypeGap` (2.2) returns through the existing `GapNote`, not a new type.
- **Known gap, deliberate:** Task 2.5 lands a failing canary as `.todo`. That is a test that cannot fail, which this repo normally forbids — it is accepted here only because the lane is simultaneously classified `known-dead` with a linked issue, and anti-stale rule 1 fails the build the moment the writer starts emitting the key. The `.todo` cannot outlive the fix.
