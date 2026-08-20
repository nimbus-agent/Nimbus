# First-Class Negation Queries (W6-B.1) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship three negation predicates — "PRs that don't touch X", "deploys with no downstream incident", "people who haven't reviewed" — each proving its backing data exists before answering, plus `--explain`.

**Architecture:** Each predicate is one flag on the command whose row shape it already matches (`nimbus query` for items, `nimbus people list` for people). Gateway-side, each is an anti-join guarded by a substrate probe: empty substrate refuses, partial substrate excludes per row and reports the shortfall. `--explain` returns the SQL and the probe result as sibling keys in the existing response envelope.

**Tech Stack:** Bun v1.2+, TypeScript 7.x strict with `exactOptionalPropertyTypes`, `bun:sqlite`, `bun:test`, Biome.

**Spec:** [`docs/superpowers/specs/2026-08-20-negation-queries-design.md`](../specs/2026-08-20-negation-queries-design.md)
**Review response:** [`docs/superpowers/specs/2026-08-20-negation-queries-design-review-response.md`](../specs/2026-08-20-negation-queries-design-review-response.md)

## Global Constraints

- **No `any`.** `unknown` for external data. TypeScript strict is non-negotiable.
- **Worktree:** `C:\gitrep\Nimbus\.claude\worktrees\w6b-negation-queries`, branch `dev/asafgolombek/w6b-negation-queries`. Never commit on `main`. This session is worktree-isolated — git commands must not target the shared checkout.
- **All SQLite writes** go through `dbRun` / `dbExec` / `dbStmtRun` (I14 / D12). This plan adds READS only; no writes, no migration.
- **Path matching uses `GLOB`, never `LIKE`**, always a bound parameter. Measured: `'Tests/a.ts' LIKE 'tests/%'` → 1 (case-insensitive) and `'src/myXfile.ts' LIKE 'src/my_file.ts'` → 1 (`_` is a wildcard). Both 0 under `GLOB`.
- **No value interpolation into SQL.** Every predicate parameter is bound.
- **Empty substrate REFUSES** (`process.exitCode = 1`); partial substrate excludes per row and reports counts. Never include an unverified row with a caveat.
- **Subject-type scoping is mandatory:** `--not-touching` requires `--type pr`, `--no-downstream-incident` requires `--type deployment`. A conflicting `--type` is an error, never a silent re-scope.
- **No new IPC method**, no Tauri allowlist change — `ALLOWED_METHODS` stays **105** (asserted at `packages/ui/src-tauri/src/gateway_bridge.rs:594`). New optional FIELDS on existing methods only.
- **No new schema, no migration.** All three predicates read tables and edges that already exist.
- **Two test trees.** `packages/gateway/src/...` is not the whole surface — `packages/gateway/test/unit/...` holds branch-level tests. Run both. Scoping to `src/` alone let a regression through on the previous branch.
- `bun test` **can exit 0 while reporting failures** — quote pass/fail counts, never the exit code.
- `bun run typecheck:tests` prints "ADVISORY on win32" and **exits 0 even with violations** — quote the violation count.
- Coverage floor: every touched file ≥85% line AND ≥80% branch. `audit:coverage-floor` is CI-Linux-authoritative.
- Run `bun run preflight:fast` before declaring any task done.

## File Structure

| File | Responsibility |
| --- | --- |
| `packages/gateway/src/index/negation-predicates.ts` | The three anti-join SQL builders + their substrate probes. Pure; no I/O beyond the passed `Database`. |
| `packages/gateway/src/index/negation-predicates.test.ts` | Unit tests over a real in-memory SQLite. |
| `packages/gateway/src/ipc/diagnostics-rpc.ts` | `index.queryItems` gains `notTouching` / `noDownstreamIncident` / `explain` params and `gaps` / `explain` response keys. |
| `packages/gateway/src/ipc/people-rpc.ts` | `people.list` gains `notReviewed` / `sinceMs` / `explain`. |
| `packages/cli/src/commands/query.ts` | `--not-touching`, `--no-downstream-incident`, `--explain`, type-scoping validation, gap + explain output. |
| `packages/cli/src/commands/people.ts` | `--not-reviewed`, `--since`, `--explain` on the `list` subcommand. |

---

## Task 1: Pin the spec's command examples against the real parsers

**Files:**

- Create: `packages/cli/src/commands/negation-examples.test.ts`

**Interfaces:**

- Produces: nothing consumed by later tasks. This task exists to catch a defect class, not to build a component.

**Why this is Task 1.** The spec shipped TWO command examples that could not run: `nimbus people --not-reviewed` (needs the `list` subcommand) and `nimbus query --type pr ...` (needs `--service`). Both were found by reading, after review. A test that runs each documented example through the real argument parser turns that class of defect from "someone notices" into "CI fails".

- [ ] **Step 1: Read both parsers first**

Read `packages/cli/src/commands/query.ts` (`runQuery`) and `packages/cli/src/commands/people.ts`
(`runPeople`). Note exactly how each rejects bad input — `runQuery` THROWS
`Missing --service (or use --sql for guarded SELECT)`, while `runPeople` writes to `console.error`
and sets `process.exitCode = 1`. They fail differently, and the test must assert each one's actual
shape rather than a shared assumption.

- [ ] **Step 2: Write the failing test**

Create `packages/cli/src/commands/negation-examples.test.ts`. Assert that each example from the
spec reaches its command's argument validation WITHOUT hitting an "unknown subcommand" or "missing
required flag" error. Do not let it reach the gateway — there is none in a unit test; assert on the
validation outcome only.

```ts
import { describe, expect, test } from "bun:test";

// The three commands exactly as `docs/superpowers/specs/2026-08-20-negation-queries-design.md`
// documents them. If a doc example stops parsing, this file fails — which is the point.
const DOCUMENTED = [
  ["query", ["--service", "github", "--type", "pr", "--not-touching", "tests/**"]],
  ["query", ["--service", "github", "--type", "deployment", "--no-downstream-incident"]],
  ["people", ["list", "--not-reviewed", "--since", "7d"]],
] as const;

describe("documented negation examples parse", () => {
  test.each(DOCUMENTED)("%s example reaches validation", async (cmd, args) => {
    // Assert on the FAILURE MODE, not on success: with no gateway running these cannot
    // complete, but they must fail for a connection reason — never for "unknown subcommand"
    // or "missing --service", which would mean the documented syntax is wrong.
    const err = await captureError(cmd, [...args]);
    // NEGATIVE: it must not fail on syntax.
    expect(err).not.toMatch(/Unknown people subcommand/i);
    expect(err).not.toMatch(/Missing --service/i);
    // POSITIVE: it must have got PAST validation and reached the IPC layer. Without this the
    // test passes vacuously if a command ever swallows a bad flag and returns early — two
    // `not.toMatch` assertions are both satisfied by an empty string.
    expect(err).toMatch(/gateway is not running|GatewayNotRunning/i);
  });
});
```

**Make the positive assertion deterministic, and do NOT match OS socket text.** The suggestion to
assert `connect ENOENT` / `fetch failed` would couple this test to platform-specific error strings
— Unix domain sockets and Windows named pipes fail differently, and this repo gates on all three
OSes. Instead, `withGatewayIpc` (`packages/cli/src/lib/with-gateway-ipc.ts:64-66`) throws a
code-owned `GatewayNotRunningError` when no gateway state file is found, which is stable across
platforms.

Force that state in the test rather than depending on the developer's machine, so
`readGatewayState` returns `undefined` whether or not a real gateway happens to be running.
Without this the test passes in CI and fails on a developer machine with a live gateway — the
worst kind of flake, because it looks like a real regression.

**`NIMBUS_CONFIG_DIR` does NOT do this — verified, after this plan originally claimed it did.**
`gatewayStatePath` reads `paths.dataDir` (`packages/cli/src/lib/gateway-process.ts:38-39`), and
`packages/cli/src/paths.ts:46` states outright that "Only `configDir` moves — `dataDir`,
`socketPath`, and `extensionsDir`" are unaffected by that variable. Setting it would leave the test
reading the developer's real gateway state while appearing isolated.

Override the platform variables that actually feed `dataDir` instead — `LOCALAPPDATA` / `APPDATA`
on win32, `HOME` on darwin, `XDG_DATA_HOME` elsewhere — pointed at a fresh `mkdtempSync` directory
per case, saved and restored around each. Confirm the override really controls resolution by
probing both directions: no file present yields `GatewayNotRunningError`, and a fake `gateway.json`
written under the overridden path makes the code attempt a real connection instead.

You must write `captureError` yourself: invoke `runQuery` / `runPeople` inside a try/catch, capture
both a thrown message and anything written to `console.error`, and return the combined string.
`runPeople` does NOT throw — it sets `process.exitCode` — so capturing only exceptions would make
this test pass vacuously for the people case. Restore `console.error` and `process.exitCode` after
each case.

- [ ] **Step 3: Red-prove the test against the HISTORICAL broken examples**

The obvious fail-first check does not work here, and it is worth knowing why: neither `runQuery`
nor `runPeopleList` maintains a flag allowlist, so an unrecognised flag is silently ignored and the
documented examples ALREADY parse before any source change. A "run it and watch it fail" step would
find nothing, and passing it would prove nothing.

Red-prove the test against the defect it actually exists to catch instead. Temporarily replace the
`DOCUMENTED` entries with the two forms that shipped in the spec and could NOT run:

```ts
["people", ["--not-reviewed", "--since", "7d"]],            // missing the `list` subcommand
["query", ["--type", "pr", "--not-touching", "tests/**"]],  // missing --service
```

Run the file and confirm BOTH cases FAIL — the first on `Unknown people subcommand`, the second on
`Missing --service`. Then restore the correct entries and confirm green. Report both failure
outputs. If either passes, the test does not catch the defect class this task exists for, and you
should say so rather than proceeding.

- [ ] **Step 4: Make the test pass by accepting-and-ignoring the flags**

In `runQuery`, consume `--not-touching` and `--no-downstream-incident` via the existing `takeFlag`
/ `args.includes` style so they no longer look unknown. In `runPeopleList`, consume `--not-reviewed`
and `--since`. Do NOT implement behaviour yet — later tasks do that. The point of this step is that
the examples parse.

- [ ] **Step 5: Run the test and confirm it passes**

Run: `bun test packages/cli/src/commands/negation-examples.test.ts`
Expected: PASS, 3 cases.

- [ ] **Step 6: Commit**

```bash
git add packages/cli/src/commands/
git commit -F - <<'EOF'
test(cli): pin the documented negation examples to the real parsers

The spec shipped two examples that could not run - nimbus people
--not-reviewed needs the list subcommand, and nimbus query needs
--service. Both were caught by reading, after review.

This runs each documented example through the actual argument parser,
so a doc example that stops parsing fails CI instead of waiting for
someone to notice. runPeople sets process.exitCode rather than
throwing, so the helper captures console.error too - capturing only
exceptions would pass vacuously for that case.
EOF
```

---

## Task 2: The three predicate builders and their substrate probes

**Files:**

- Create: `packages/gateway/src/index/negation-predicates.ts`
- Create: `packages/gateway/src/index/negation-predicates.test.ts`

**Interfaces:**

- Produces:
  - `type SubstrateProbe = { readonly probeSql: string; readonly passed: boolean; readonly rowCount: number }`
  - `type NegationGaps = { readonly excludedNoCoverage: number; readonly excludedTruncated: number }`
  - `probePrFileCoverage(db): SubstrateProbe`
  - `probeCorrelatesWith(db): SubstrateProbe`
  - `probeReviewed(db): SubstrateProbe`
  - `buildNotTouchingSql(pathGlob: string): { sql: string; vals: Array<string | number> }`
  - `buildNoDownstreamIncidentSql(): { sql: string; vals: Array<string | number> }`
  - `buildNotReviewedSql(sinceMs: number): { sql: string; vals: Array<string | number> }`
  - `countNotTouchingExclusions(db): NegationGaps`
  - `CORRELATION_WINDOW_MS` re-exported for the CLI to print

- [ ] **Step 1: Write the failing tests**

Create `packages/gateway/src/index/negation-predicates.test.ts`. Build a real in-memory database
with the minimum schema each predicate reads. Read
`packages/gateway/src/index/pr-changed-file-v55-sql.ts` and
`packages/gateway/src/index/graph-v7-sql.ts` and reuse their exported SQL constants rather than
hand-writing table definitions — a hand-written schema that drifts from the real one makes every
test here meaningless.

```ts
import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";

import { PR_CHANGED_FILE_V55_SQL } from "./pr-changed-file-v55-sql.ts";
import {
  buildNotTouchingSql,
  countNotTouchingExclusions,
  probeCorrelatesWith,
  probePrFileCoverage,
  probeReviewed,
} from "./negation-predicates.ts";

describe("substrate probes", () => {
  test("probePrFileCoverage fails on an empty coverage table", () => {
    const db = makeDb();
    const p = probePrFileCoverage(db);
    expect(p.passed).toBe(false);
    expect(p.rowCount).toBe(0);
    expect(p.probeSql).toContain("pr_files_state");
    db.close();
  });

  test("probePrFileCoverage passes once one PR is covered", () => {
    const db = makeDb();
    seedCoveredPr(db, "p1", ["src/a.ts"]);
    expect(probePrFileCoverage(db).passed).toBe(true);
    db.close();
  });

  test("probeReviewed and probeCorrelatesWith fail on an empty graph", () => {
    const db = makeDb();
    expect(probeReviewed(db).passed).toBe(false);
    expect(probeCorrelatesWith(db).passed).toBe(false);
    db.close();
  });
});

describe("buildNotTouchingSql", () => {
  test("excludes a PR that touches the glob", () => {
    const db = makeDb();
    seedCoveredPr(db, "p1", ["tests/a.ts"]);
    seedCoveredPr(db, "p2", ["src/a.ts"]);
    expect(runIds(db, buildNotTouchingSql("tests/*"))).toEqual(["p2"]);
    db.close();
  });

  test("a PR with NO coverage row is excluded, not returned", () => {
    const db = makeDb();
    seedCoveredPr(db, "p1", ["src/a.ts"]);
    seedUncoveredPr(db, "p2");
    expect(runIds(db, buildNotTouchingSql("tests/*"))).toEqual(["p1"]);
    expect(countNotTouchingExclusions(db).excludedNoCoverage).toBe(1);
    db.close();
  });

  test("a TRUNCATED PR is excluded on the same footing as an uncovered one", () => {
    const db = makeDb();
    seedTruncatedPr(db, "p1", ["src/a.ts"]);
    expect(runIds(db, buildNotTouchingSql("tests/*"))).toEqual([]);
    expect(countNotTouchingExclusions(db).excludedTruncated).toBe(1);
    db.close();
  });

  test("matching is case-sensitive - Tests/ does not answer a tests/ question", () => {
    const db = makeDb();
    seedCoveredPr(db, "p1", ["Tests/a.ts"]);
    expect(runIds(db, buildNotTouchingSql("tests/*"))).toEqual(["p1"]);
    db.close();
  });

  test("an underscore in the pattern is literal, not a wildcard", () => {
    const db = makeDb();
    seedCoveredPr(db, "p1", ["src/myXfile.ts"]);
    expect(runIds(db, buildNotTouchingSql("src/my_file.ts"))).toEqual(["p1"]);
    db.close();
  });

  test("a PR that DELETED a matching file still counts as touching it", () => {
    const db = makeDb();
    seedCoveredPr(db, "p1", ["tests/gone.ts"], "removed");
    expect(runIds(db, buildNotTouchingSql("tests/*"))).toEqual([]);
    db.close();
  });
});

// The graph_entity BRIDGE is the highest-consequence join in this plan, and a wrong one fails
// SILENTLY in the dangerous direction: no edges found means every deployment looks clean, and
// every person looks like they never reviewed. These tests exist to make a wrong join loud.
describe("buildNoDownstreamIncidentSql", () => {
  test("a deployment WITH a correlates_with edge is excluded", () => {
    const db = makeDb();
    seedDeploymentWithIncident(db, "d1");
    expect(runIds(db, buildNoDownstreamIncidentSql())).toEqual([]);
    db.close();
  });

  test("a deployment with no edge is returned", () => {
    const db = makeDb();
    seedDeploymentWithoutIncident(db, "d2");
    expect(runIds(db, buildNoDownstreamIncidentSql())).toEqual(["d2"]);
    db.close();
  });

  test("an incident's own edge does not make the incident look like a clean deployment", () => {
    const db = makeDb();
    seedDeploymentWithIncident(db, "d1");
    // Only `type = 'deployment'` rows may ever appear, whatever else the graph holds.
    expect(runIds(db, buildNoDownstreamIncidentSql())).toEqual([]);
    db.close();
  });
});

describe("buildNotReviewedSql", () => {
  test("a person WITH a recent reviewed edge is excluded", () => {
    const db = makeDb();
    seedPersonWithReview(db, "alice", 5_000);
    expect(runIds(db, buildNotReviewedSql(1_000))).toEqual([]);
    db.close();
  });

  test("a person with no reviewed edge is returned", () => {
    const db = makeDb();
    seedPersonWithoutReview(db, "bob");
    expect(runIds(db, buildNotReviewedSql(1_000))).toEqual(["bob"]);
    db.close();
  });

  test("a review OLDER than the cutoff does not count - the person is returned", () => {
    const db = makeDb();
    seedPersonWithReview(db, "carol", 500);
    expect(runIds(db, buildNotReviewedSql(1_000))).toEqual(["carol"]);
    db.close();
  });
});
```

`seedDeploymentWithIncident` / `seedDeploymentWithoutIncident` / `seedPersonWithReview` /
`seedPersonWithoutReview` are file-local too. Each must build the row the REAL populator builds —
a `graph_entity` whose `external_id` is the item id (or person id) and whose `type` is
`deployment` / `person`, with `graph_relation.from_id` pointing at that entity's PRIMARY KEY.
Seeding `from_id = item.id` directly would make these tests pass against a broken join, which is
the one thing they exist to prevent.

Write `makeDb`, `seedCoveredPr`, `seedUncoveredPr`, `seedTruncatedPr` and `runIds` as file-local
consts. **Do NOT export them** — importing a `.test.ts` module re-executes its `describe`/`test`
calls, which silently re-runs this whole suite inside the importer (measured on a previous branch:
7 tests where 1 was expected).

- [ ] **Step 2: Run and confirm failure**

Run: `bun test packages/gateway/src/index/negation-predicates.test.ts`
Expected: FAIL — cannot resolve `./negation-predicates.ts`.

- [ ] **Step 3: Write the module**

Create `packages/gateway/src/index/negation-predicates.ts`. Key requirements, each of which a test
above pins:

```ts
import type { Database } from "bun:sqlite";

export type SubstrateProbe = {
  readonly probeSql: string;
  readonly passed: boolean;
  readonly rowCount: number;
};

export type NegationGaps = {
  readonly excludedNoCoverage: number;
  readonly excludedTruncated: number;
};

/**
 * Re-exported so the CLI prints the REAL window rather than restating "2h" and drifting.
 *
 * NOTE: `CORRELATION_WINDOW_MS` is currently module-PRIVATE in `graph/graph-populator.ts:702`
 * (`const`, not `export const`). Your first edit in this step is to add `export` to that
 * declaration. Do not copy the value here — a second literal is exactly the drift this
 * re-export exists to prevent.
 */
export { CORRELATION_WINDOW_MS } from "../graph/graph-populator.ts";

function probe(db: Database, probeSql: string): SubstrateProbe {
  const row = db.query(probeSql).get() as { n?: number } | null;
  const rowCount = typeof row?.n === "number" ? row.n : 0;
  return { probeSql, passed: rowCount > 0, rowCount };
}

export function probePrFileCoverage(db: Database): SubstrateProbe {
  return probe(db, "SELECT COUNT(*) AS n FROM pr_files_state");
}

export function probeCorrelatesWith(db: Database): SubstrateProbe {
  return probe(db, "SELECT COUNT(*) AS n FROM graph_relation WHERE type = 'correlates_with'");
}

export function probeReviewed(db: Database): SubstrateProbe {
  return probe(db, "SELECT COUNT(*) AS n FROM graph_relation WHERE type = 'reviewed'");
}

/**
 * PRs with no indexed changed-file path matching `pathGlob`.
 *
 * Fail-closed by TWO independent mechanisms, and both must stay: the INNER JOIN to
 * `pr_files_state` (an uncovered PR has no row to join), and `s.truncated = 0` (on an uncovered
 * PR that column is NULL, and `NULL = 0` is NULL, which WHERE treats as not-true). Either alone
 * excludes an unfetched PR, so swapping the JOIN for a LEFT JOIN does NOT by itself reintroduce
 * the bug — it takes losing both, e.g. a LEFT JOIN plus `COALESCE(s.truncated, 0) = 0`.
 *
 * GLOB, never LIKE: LIKE is case-insensitive and treats `_` as a wildcard, both measured, both
 * wrong for paths.
 */
export function buildNotTouchingSql(pathGlob: string): {
  sql: string;
  vals: Array<string | number>;
} {
  return {
    sql: `SELECT i.id AS id
            FROM item i
            JOIN pr_files_state s ON s.item_id = i.id
           WHERE i.type = 'pr'
             AND s.truncated = 0
             AND NOT EXISTS (
                   SELECT 1 FROM pr_changed_file f
                    WHERE f.item_id = i.id AND f.path GLOB ?1
                 )
           ORDER BY i.id`,
    vals: [pathGlob],
  };
}
```

The other two builders need a `graph_entity` BRIDGE — neither `item.id` nor `person.id` joins to
`graph_relation.from_id` directly, and assuming they do is the trap here. Both joins below were
verified against the tree, so use them as written:

```ts
/**
 * Deployments with no outgoing `correlates_with` edge.
 *
 * The bridge is required: `syncTimelineEventGraph` (`graph/graph-populator.ts:854`) upserts the
 * deployment's graph entity as `{ type: "deployment", externalId: row.id }`, so the item's id is
 * the entity's EXTERNAL id, never its primary key. Joining `graph_relation.from_id = item.id`
 * would match nothing and silently return every deployment as "clean" — the exact false positive
 * this feature exists to prevent.
 *
 * No time filter, deliberately: `CORRELATION_WINDOW_MS` is applied at WRITE time by the populator
 * and `graph_relation.created_at` is the write timestamp, not the event time. See spec § 4.2.
 */
export function buildNoDownstreamIncidentSql(): {
  sql: string;
  vals: Array<string | number>;
} {
  return {
    sql: `SELECT i.id AS id
            FROM item i
            JOIN graph_entity e ON e.external_id = i.id AND e.type = 'deployment'
           WHERE i.type = 'deployment'
             AND NOT EXISTS (
                   SELECT 1 FROM graph_relation r
                    WHERE r.from_id = e.id AND r.type = 'correlates_with'
                 )
           ORDER BY i.id`,
    vals: [],
  };
}

/**
 * People with no outgoing `reviewed` edge newer than `sinceMs`.
 *
 * Same bridge: `graph-populator.ts:341-349` upserts the person entity as
 * `{ type: "person", externalId: row.authorId }` and emits `reviewed` FROM it, and `row.authorId`
 * is the `person.id`. Unlike the deployment predicate this one DOES filter on `created_at`,
 * because `--since` is meant to bound the review window and that is the timestamp available.
 */
export function buildNotReviewedSql(sinceMs: number): {
  sql: string;
  vals: Array<string | number>;
} {
  return {
    sql: `SELECT p.id AS id
            FROM person p
            JOIN graph_entity e ON e.external_id = p.id AND e.type = 'person'
           WHERE NOT EXISTS (
                   SELECT 1 FROM graph_relation r
                    WHERE r.from_id = e.id
                      AND r.type = 'reviewed'
                      AND r.created_at >= ?1
                 )
           ORDER BY p.id`,
    vals: [sinceMs],
  };
}
```

**One caveat on `buildNotReviewedSql` you must verify, not assume:** `graph_relation.created_at` is
the WRITE time, so `--since 7d` means "no reviewed edge WRITTEN in 7 days", not "no review
performed in 7 days". If a re-graph rewrites edges, every edge's `created_at` moves. Check whether
`regraph.ts` rewrites `reviewed` edges; if it does, say so in your report and record it as a stated
bound in Task 6's docs rather than letting the flag imply event-time semantics it does not have.

`countNotTouchingExclusions` returns the two counts separately: PRs of type `pr` with no
`pr_files_state` row, and those with `truncated = 1`. They mean different things to a reader and
must not be summed.

- [ ] **Step 4: Run the tests and confirm they pass**

Run: `bun test packages/gateway/src/index/negation-predicates.test.ts`
Expected: PASS, **15 tests** — 3 probes, 6 `buildNotTouchingSql`, 3 `buildNoDownstreamIncidentSql`,
3 `buildNotReviewedSql`. If your count differs, reconcile it rather than adjusting the number; a
stale count is how an invented or dropped test hides.

- [ ] **Step 5: Red-prove the fail-closed guard**

This is the guard the whole feature rests on, so prove it rejects rather than trusting green.

Temporarily change `JOIN pr_files_state` to `LEFT JOIN` **and** `s.truncated = 0` to
`COALESCE(s.truncated, 0) = 0` — BOTH, because either alone leaves the guard intact for the reason
the doc comment gives. Then run the test file.

Expected: "a PR with NO coverage row is excluded, not returned" FAILS, receiving `["p1","p2"]`.
**Restore both and re-run to green.** Record the observed failure output in your report. If it does
NOT fail, stop and say so — the test is not pinning what it claims.

**Then red-prove the graph bridge too**, because it fails in the same silent direction. Change
`e.external_id = i.id` to `e.id = i.id` in `buildNoDownstreamIncidentSql` — the wrong join a
reader would most plausibly write — and confirm "a deployment WITH a correlates_with edge is
excluded" FAILS by returning `["d1"]`. Restore and re-run. Report both outputs. A bad bridge
returns every deployment as clean, which reads as a good answer.

- [ ] **Step 6: Commit**

```bash
git add packages/gateway/src/index/negation-predicates.ts packages/gateway/src/index/negation-predicates.test.ts
git commit -F - <<'EOF'
feat(index): negation predicate builders and their substrate probes

Three anti-joins plus a probe each. The probe is what separates "we
checked and it does not match" from "we never had the data" - for a
negation the second silently produces rows rather than costing them.

Fail-closed by two independent mechanisms on the file predicate, both
documented at the builder: the inner join to the coverage table, and
the truncated comparison, on which NULL = 0 is NULL. Either alone
excludes an unfetched PR, so the regression to guard is losing both.
EOF
```

---

## Task 3: Wire the item predicates into `index.queryItems`

**Files:**

- Modify: `packages/gateway/src/ipc/diagnostics-rpc.ts` (`rpcIndexQueryItems`, around `:325-356`)
- Modify: `packages/gateway/src/ipc/diagnostics-rpc.test.ts`

**Interfaces:**

- Consumes: everything Task 2 produces.
- Produces: `index.queryItems` accepts `notTouching?: string`, `noDownstreamIncident?: boolean`, `explain?: boolean`; returns `{ items, meta, gaps?, explain? }`.

- [ ] **Step 1: Write the failing test**

Add to `packages/gateway/src/ipc/diagnostics-rpc.test.ts`, matching the harness that file already
uses (read it first — it has a real-SQLite context builder; do not invent a second one):

```ts
test("index.queryItems refuses --not-touching when no PR coverage exists", async () => {
  const ctx = makeCtxWithIndex(); // the file's existing helper
  const out = await dispatchDiagnosticsRpc("index.queryItems", { notTouching: "tests/*" }, ctx);
  expect(out.kind).toBe("hit");
  const v = out.value as { status?: string; reason?: string };
  expect(v.status).toBe("refused");
  expect(v.reason).toBe("missing_substrate");
});

test("index.queryItems returns gaps alongside items, not inside meta", async () => {
  const ctx = makeCtxWithIndex();
  seedCoveredPr(ctx, "p1", ["src/a.ts"]);
  seedUncoveredPr(ctx, "p2");
  const out = await dispatchDiagnosticsRpc("index.queryItems", { notTouching: "tests/*" }, ctx);
  const v = out.value as {
    items: unknown[];
    meta: Record<string, unknown>;
    gaps: { excludedNoCoverage: number };
  };
  expect(v.items).toHaveLength(1);
  expect(v.gaps.excludedNoCoverage).toBe(1);
  expect(v.meta["gaps"]).toBeUndefined(); // sibling key, never nested in meta
});

test("explain carries the SQL and the probe result", async () => {
  const ctx = makeCtxWithIndex();
  seedCoveredPr(ctx, "p1", ["src/a.ts"]);
  const out = await dispatchDiagnosticsRpc(
    "index.queryItems",
    { notTouching: "tests/*", explain: true },
    ctx,
  );
  const v = out.value as {
    explain: { sql: string; params: unknown[]; substrate: { passed: boolean; probeSql: string } };
  };
  expect(v.explain.sql).toContain("NOT EXISTS");
  expect(v.explain.params).toContain("tests/*");
  expect(v.explain.substrate.passed).toBe(true);
  expect(v.explain.substrate.probeSql).toContain("pr_files_state");
});
```

- [ ] **Step 2: Run and confirm failure**

Run: `bun test packages/gateway/src/ipc/diagnostics-rpc.test.ts`
Expected: FAIL — the params are ignored today, so no `status`, `gaps` or `explain` appears.

- [ ] **Step 3: Implement in `rpcIndexQueryItems`**

Extract the new params with the same defensive narrowing the handler already uses for `sinceMs` and
`limit` (read `:326-347` and match it — do not introduce a different validation style in one
function). Then:

1. If a negation param is present, run its probe FIRST. On `passed === false`, return the refusal
   document `{ status: "refused", reason: "missing_substrate", message, remediation }`.
2. Otherwise run the predicate SQL, intersected with the existing filters.
3. Attach `gaps` when the predicate has per-row exclusions (only `notTouching` does).
4. Attach `explain` only when `explain === true`.

`explain` and `gaps` are SIBLINGS of `items`, matching the existing `{ items, meta }` envelope.
`meta` holds counts today and gains nothing here.

- [ ] **Step 4: Run and confirm pass**

Run: `bun test packages/gateway/src/ipc/diagnostics-rpc.test.ts`
Expected: PASS.

- [ ] **Step 5: Confirm no new IPC method appeared**

Run: `grep -n "assert_eq!(ALLOWED_METHODS.len()" packages/ui/src-tauri/src/gateway_bridge.rs`
Expected: still `105`. You added FIELDS to an existing method; if this number needs to change, you
added a method by mistake.

- [ ] **Step 6: Commit**

```bash
git add packages/gateway/src/ipc/
git commit -F - <<'EOF'
feat(ipc): negation params and explain on index.queryItems

Probe first, then query: an empty substrate returns a structured
refusal rather than an empty result set, because with no data every row
is unverifiable and an empty answer reads as a finding.

gaps and explain are siblings of items, matching the existing envelope;
meta holds counts and gains nothing. No new method - ALLOWED_METHODS
stays 105.
EOF
```

---

## Task 4: Wire `--not-reviewed` into `people.list`

**Files:**

- Modify: `packages/gateway/src/ipc/people-rpc.ts` (`rpcPeopleList`)
- Modify: `packages/gateway/src/ipc/people-rpc.test.ts`

**Interfaces:**

- Consumes: `probeReviewed`, `buildNotReviewedSql` (Task 2).
- Produces: `people.list` accepts `notReviewed?: boolean`, `sinceMs?: number`, `explain?: boolean`; same `{ …, gaps?, explain? }` sibling convention and the same refusal document.

- [ ] **Step 1: Read `rpcPeopleList` and its test harness first**

Read `packages/gateway/src/ipc/people-rpc.ts` around `rpcPeopleList` and the existing
`people-rpc.test.ts`. Match its response envelope exactly — if it returns a bare array rather than
`{ people, meta }`, the refusal and `explain` still attach as documented in the spec, but say in
your report what the real envelope is, since the spec assumed a `{ items, meta }`-like shape.

- [ ] **Step 2: Write the failing test**

**`dispatchPeopleRpc` takes an OPTIONS OBJECT, not positional arguments** — its signature is
`dispatchPeopleRpc({ method, params, localIndex })` (`people-rpc.ts:154`), unlike
`dispatchDiagnosticsRpc(method, params, ctx)` which IS positional. The two dispatchers differ; do
not copy Task 3's call shape here.

```ts
test("people.list refuses --not-reviewed when no reviewed edges exist", () => {
  const localIndex = makePeopleIndex(); // the file's existing helper
  const out = dispatchPeopleRpc({
    method: "people.list",
    params: { notReviewed: true, sinceMs: 1 },
    localIndex,
  });
  const v = (out as { value: { status?: string; reason?: string } }).value;
  expect(v.status).toBe("refused");
  expect(v.reason).toBe("missing_substrate");
});

test("people.list returns only people with no reviewed edge in the window", () => {
  const localIndex = makePeopleIndex();
  seedPersonWithReview(localIndex, "alice", Date.now());
  seedPersonWithoutReview(localIndex, "bob");
  const out = dispatchPeopleRpc({
    method: "people.list",
    params: { notReviewed: true, sinceMs: Date.now() - 7 * 86_400_000 },
    localIndex,
  });
  // `people.list` returns a BARE ARRAY, not a wrapper object — verified at
  // `people-rpc.ts:87-90`, which returns `value: rows.map(...)`.
  const ids = (out as { value: Array<{ id: string }> }).value.map((p) => p.id);
  expect(ids).toEqual(["bob"]);
});
```

`dispatchPeopleRpc` is SYNCHRONOUS (it returns a value, not a promise), so these tests need no
`async`.

**The bare-array envelope is a genuine design problem for this task, not just a destructuring
detail.** `index.queryItems` returns `{ items, meta }`, so Task 3 attaches `gaps` and `explain` as
sibling keys. `people.list` has no wrapper to attach anything to. Resolve it this way, and record
the choice in your report:

- The REFUSAL document already replaces the whole payload, so it works unchanged — return the
  refusal object in place of the array.
- For `explain`, do NOT wrap the array in a new object. That would be a breaking change to
  `people.list` for every existing caller, to serve an optional debug flag. Instead return the
  wrapper ONLY when `explain === true` is requested — the caller asking for `explain` is the only
  caller who can receive a different shape, and it opted in by asking.
- Say plainly in your report that `people.list` therefore has two response shapes, gated on an
  explicit request flag. That asymmetry is worth a reviewer seeing rather than discovering.

- [ ] **Step 3: Run and confirm failure**

Run: `bun test packages/gateway/src/ipc/people-rpc.test.ts`
Expected: FAIL — params ignored.

- [ ] **Step 4: Implement, then run to green**

Same order as Task 3: probe first, refuse on empty, otherwise filter. `--not-reviewed` has NO
per-row partial state — the `reviewed` edge set is a global fact — so it emits **no** `gaps` key.
Do not invent one for symmetry; an always-zero gap count would imply a check that is not happening.

Run: `bun test packages/gateway/src/ipc/people-rpc.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/gateway/src/ipc/
git commit -F - <<'EOF'
feat(ipc): not-reviewed predicate on people.list

Probe first, refuse on an empty reviewed edge set. Emits no gaps key:
this predicate has no per-row partial state, and an always-zero gap
count would imply a check that is not happening.
EOF
```

---

## Task 5: CLI flags, scoping validation, and output

**Files:**

- Modify: `packages/cli/src/commands/query.ts`
- Modify: `packages/cli/src/commands/people.ts`
- Modify: `packages/cli/src/commands/query.test.ts`, `packages/cli/src/commands/people.test.ts`

**Interfaces:**

- Consumes: the IPC fields from Tasks 3 and 4.

- [ ] **Step 1: Write the failing tests**

Four behaviours, each its own test:

```ts
test("--not-touching without --type pr is rejected", async () => {
  await expect(runQuery(["--service", "github", "--not-touching", "tests/*"])).rejects.toThrow(
    /--not-touching requires --type pr/,
  );
});

test("--not-touching with a conflicting --type is rejected", async () => {
  await expect(
    runQuery(["--service", "github", "--type", "commit", "--not-touching", "tests/*"]),
  ).rejects.toThrow(/--not-touching requires --type pr/);
});

test("a refusal exits 1 and prints the remediation to stderr", async () => {
  // stub the IPC to return the refusal document
  const { stderr, exitCode } = await runQueryCapturing(refusalStub, [
    "--service", "github", "--type", "pr", "--not-touching", "tests/*",
  ]);
  expect(exitCode).toBe(1);
  expect(stderr).toMatch(/missing_substrate|no .* indexed/i);
});

test("--json refusal is a parseable document on stdout", async () => {
  const { stdout, exitCode } = await runQueryCapturing(refusalStub, [
    "--service", "github", "--type", "pr", "--not-touching", "tests/*", "--json",
  ]);
  expect(exitCode).toBe(1);
  expect(() => JSON.parse(stdout)).not.toThrow();
  expect(JSON.parse(stdout).status).toBe("refused");
});
```

The `--json` test must **parse** the output, not string-match it. A refusal printed alongside JSON
rather than as JSON is the obvious way to break this, and only parsing catches it.

- [ ] **Step 2: Run and confirm failure**

Run: `bun test packages/cli/src/commands/query.test.ts`
Expected: FAIL — Task 1 made the flags parse but implemented no behaviour.

- [ ] **Step 3: Implement the CLI behaviour**

- Validate scoping BEFORE any IPC call: `--not-touching` requires `--type pr`,
  `--no-downstream-incident` requires `--type deployment`. Reject a conflicting `--type` with the
  message the tests assert.
- Pass the params through; on a refusal response, print per the spec's § 6 stream split — human
  message to stderr, `--json` document to stdout — and set `process.exitCode = 1`.
- Always print the gap line when `gaps` is present, reporting the two counts SEPARATELY.
- Print the `explain` block when `--explain` is set; under `--json` put it in the document.
- For `--no-downstream-incident`, print the correlation window **derived from
  `CORRELATION_WINDOW_MS`**, never a literal "2h".
- In `people.ts`, add the flags to `runPeopleList` and parse `--since` with the EXISTING
  `parseSinceDurationToMs` from `packages/cli/src/lib/parse-since.ts`.

- [ ] **Step 4: Run both CLI suites**

Run: `bun test packages/cli/src/commands/query.test.ts packages/cli/src/commands/people.test.ts packages/cli/src/commands/negation-examples.test.ts`
Expected: PASS.

- [ ] **Step 5: Red-prove the scoping guard**

Remove the `--type pr` validation, run the suite, and confirm "without --type pr is rejected"
FAILS. Restore. Report the observed output. Without this the guard is unproven, and the guard is
what stops an unscoped `--not-touching` returning every item that cannot touch anything.

- [ ] **Step 6: Commit**

```bash
git add packages/cli/src/commands/
git commit -F - <<'EOF'
feat(cli): negation flags, scoping validation, and --explain

Scoping is validated before any IPC call: --not-touching requires
--type pr, because unscoped it would return every issue, message and
commit - all of which trivially do not touch tests/, since they cannot
touch anything.

Refusals follow the spec's stream split: human message to stderr, --json
document to stdout, exit 1 either way. Under --json the refusal IS the
document the caller asked for, so putting it on stderr would leave
stdout empty and indistinguishable from a zero-row success.

The correlation window is derived from CORRELATION_WINDOW_MS, never
restated, so it cannot drift from the populator.
EOF
```

---

## Task 6: Documentation

**Files:**

- Modify: `docs/CHANGELOG.md`, `docs/cli-reference.md`, `docs/roadmap.md`

- [ ] **Step 1: Verify each drift site before editing**

Run: `grep -n "W6-B\|negation" docs/roadmap.md | head -20` and read the surrounding rows. The
roadmap has an open W6-B row and a 2026-08-16 correction on it; update the row to reflect what
shipped without deleting that correction — it records why the row's original claim was wrong.

- [ ] **Step 2: Write the CHANGELOG entry**

State plainly: the three predicates and their exact syntax (including `--service` and the `list`
subcommand), `--explain`, and the **four** honesty bounds — refusal on empty substrate; per-row
exclusion ONLY for `--not-touching`; the fixed 2-hour correlation window that no flag can widen;
and that **B.2 (`nimbus ask` exposure) is NOT in this delivery**.

- [ ] **Step 3: Update the roadmap row**

Mark the negation half of W6-B shipped, and record that `ask` exposure is B.2 and still open. Do
not mark the whole row complete — that would overclaim.

- [ ] **Step 4: Run the doc gates**

Run: `bun run lint:markdown && bun run audit:links && bun run audit:status-drift && bun run audit:doc-refs`
Expected: all pass. Note `audit:links` must be run UNPIPED or checked on its own exit code — a
trailing pipe reports the pipe's status, not lychee's.

- [ ] **Step 5: Full verification**

Run, and report COUNTS for each:

- `bun run preflight:fast`
- `bun test packages/gateway` — quote pass/skip/fail
- `bun test packages/cli` — quote pass/skip/fail
- `bun run typecheck:tests` — quote the violation count, not the exit code

- [ ] **Step 6: Commit**

```bash
git add docs/
git commit -F - <<'EOF'
docs: record first-class negation queries (W6-B.1)

States the four bounds a reader needs: an empty substrate refuses
rather than returning rows; only --not-touching has per-row exclusion,
because the other two substrates are global facts; the correlation
window is fixed at two hours by the populator and no flag can widen it;
and nimbus ask exposure is B.2, not this delivery.

Marks the negation half of the W6-B row shipped without marking the row
complete, and keeps its 2026-08-16 correction, which records why the
row's original claim was wrong.
EOF
```

---

## Self-Review

**Spec coverage.** § 1 syntax → Task 1 (pinned by test) and Task 5. § 4.1 `--not-touching` →
Tasks 2, 3, 5. § 4.2 `--no-downstream-incident` incl. the derived window → Tasks 2, 3, 5. § 4.3
`--not-reviewed` incl. `parseSinceDurationToMs` reuse → Tasks 2, 4, 5. § 4.4 substrate probes →
Task 2. § 4.5 type scoping → Task 5, red-proved. § 5 `--explain` and the sibling-key envelope →
Tasks 3, 4, 5. § 6 refusal contract and stream split → Tasks 3, 4, 5. § 7 testing → each task, with
two mandatory red-proves. § 8 scope boundary → Task 6 states it in the CHANGELOG.

**A gap I am recording rather than hiding:** the spec's § 5 says `--explain` works on ANY
`query`/`people` invocation, not only negation ones. Tasks 3-5 wire it through the negation path;
the non-negation path gets it for free ONLY if `explain` is handled before the negation branch.
Task 3 Step 3 orders the handler probe-first, which risks skipping `explain` on a plain query. The
implementer must attach `explain` on every path, and Task 3's third test should be extended with a
plain `--service`-only call asserting `explain` is present. Flagged here because a reviewer reading
Task 3 alone would not see the requirement.

**Placeholder scan.** No "TBD"/"appropriate"/"as needed". Several steps say "read the existing
harness first" — each names a specific file and reason, and exists because inventing a second
harness beside an existing one is the likelier failure.

**Three defects I found in this plan while self-reviewing, all fixed above, all from checking the
tree rather than re-reading my own prose:**

1. `CORRELATION_WINDOW_MS` is module-PRIVATE (`graph-populator.ts:702` declares `const`, not
   `export const`), so Task 2's re-export would not have compiled. Task 2 now says to add the
   `export` first, and says explicitly not to copy the value instead.
2. `dispatchPeopleRpc` takes an OPTIONS OBJECT (`{ method, params, localIndex }`) while
   `dispatchDiagnosticsRpc` is POSITIONAL. My Task 4 snippet used Task 3's call shape and would
   have failed to type-check. Both signatures are now stated at the point of use.
3. `dispatchPeopleRpc` is synchronous; the snippet had it `await`ed inside `async` tests, which
   would have passed but taught the wrong shape.

**Type consistency.** `SubstrateProbe` / `NegationGaps` are defined in Task 2 and consumed
unchanged in 3-5. `probeSql`/`passed`/`rowCount` and
`excludedNoCoverage`/`excludedTruncated` keep the same names in the builders, the IPC responses and
the CLI output. `CORRELATION_WINDOW_MS` is re-exported once in Task 2 and read in Task 5 rather
than re-imported from the populator, so there is one path to the value.
