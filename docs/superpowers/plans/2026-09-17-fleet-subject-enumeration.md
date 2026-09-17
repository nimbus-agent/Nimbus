# Fleet Subject Enumeration (PR 2b) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a `[[fleet.job]]` name a sweep enumerator (`paths`/`services`/`symbols`/`terms`) instead of one subject, so the fleet rotates through every subject the index can list, a bounded slice per run, and the digest reports what moved per subject.

**Architecture:** A sweep job stays ONE job (one interval, one backoff, one `fleet_job_state` row). At execute time `FleetScheduler.runSweepJob` enumerates subjects through an injected `FleetSweepEnumerate`, takes up to `max_subjects` keys after a key-based cursor (wrapping), runs each through the existing invoker with the subject parameter merged in, and records each brief with a `subject_key`. Migration V63 rebuilds `fleet_brief` with `subject_key NOT NULL` (backfilled to `job_id`), adds sweep state columns, and subject counters on `fleet_run`. The digest groups sweep jobs into a new additive `sweeps` array; config-named jobs render byte-identically.

**Tech Stack:** Bun 1.3, TypeScript 7 strict (`exactOptionalPropertyTypes`, `noUncheckedIndexedAccess`), `bun:sqlite`, `bun:test`, Biome.

**Spec:** `docs/superpowers/specs/2026-09-17-fleet-subject-enumeration-design.md` (with the review folded in: `…-review.md`, `…-review-response.md`). Read the spec before any task.

## Global Constraints

- Worktree `C:\gitrep\Nimbus\.claude\worktrees\fleet-subject-enumeration`, branch `dev/asafgolombek/fleet-subject-enumeration`. Run `git rev-parse --abbrev-ref HEAD` before EVERY commit; another session works in parallel.
- Test data ONLY under `os.tmpdir()` / `:memory:`. Never touch `%LOCALAPPDATA%\Nimbus` or any real config dir.
- No `any`; external data is `unknown`. Build paths with `path.join`, never hardcoded separators.
- SQLite writes only through `dbRun`/`dbExec` (`packages/gateway/src/db/write.ts`, I14/D12). Migration SQL runs through the runner's `simpleStep`.
- Sort keys with `codeUnitCompare` (`packages/gateway/src/util/code-unit-compare.ts`), never `localeCompare` or SQL `ORDER BY` on user text.
- `max_subjects`: required when `sweep` is set, integer `1..500`, refused (never clamped) outside.
- `path_prefix`: case-sensitive plain-string prefix on the repo-relative POSIX path; accepted only for `paths` and `symbols`.
- No enumerator returns person-shaped subjects. `agents.negotiate` stays `deferred`.
- The I38 budget is reset once per run, never per subject. `fleet.*` stays LAN-forbidden and absent from the Tauri allowlist. No new IPC method, invariant, static rule, egress class, or HITL action type.
- Config-named jobs: Markdown digest output and each `FleetJobDigest` object must be byte-identical to before this PR.
- A red-proof is required for every test marked **(red-prove)**: after it passes, revert the production change it covers, confirm it fails, restore.
- Commit messages via `git commit -F <file>` (backticks survive), ending with `Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>`.
- Commands run from the worktree root unless stated. Scoped test: `bun test <path>`. Typecheck: `bun run typecheck`.

## Plan-time corrections to the spec (already applied to the spec)

1. `services` enumerates `loadNimbusServiceConfigsFromConfigDir` keys (`[ci.service.*]` ∪ `[metrics.dora.*]`), the loader `ipc/agents-rpc.ts` resolves `service` against — not `[ci.service.*]` alone.
2. Sweep progress is reported on `fleet.list` (which already reads `fleet_job_state`), not `fleet.status` (documented as never reading the store). Cursor-position progress ("1,400 / 3,412") is dropped: it would require enumerating on every `list`.
3. V63 adds `fleet_job_state.sweep_empty_reason`; an empty sweep's reason must be persisted to be shown.
4. The top-level digest JSON gains `sweeps` (so the response is additive, not identical); each `FleetJobDigest` stays identical.
5. `FleetSweepDigest` carries `unchangedWithinThresholdCount` separately (2a § 6.3).
6. Rules 1, 2, 6 run in `fleet/fleet-sweep-support.ts` (`config/` does not import `fleet/`); rules 3–5 in the parser.
7. `SweepSupport` is one interface with a runtime exclusivity test, not a union.

## File Structure

| File | Status | Responsibility |
|---|---|---|
| `packages/gateway/src/index/fleet-subjects-v63-sql.ts` | Create | V63 DDL: rebuild `fleet_brief` with `subject_key`, sweep state columns, run subject counters |
| `packages/gateway/src/index/migrations/runner.ts` | Modify | Register `simpleStep(62, 63, …)` |
| `packages/gateway/src/index/local-index.ts` | Modify | `CURRENT_SCHEMA_VERSION = 63` |
| `packages/gateway/src/index/migrations/runner.test.ts` | Modify | Version pin → 63; V63 runner test |
| `packages/gateway/src/fleet/fleet-store.ts` | Modify | `subjectKey` on briefs; subject-scoped reads; sweep state; subject counters in `closeRun` |
| `packages/gateway/src/config/fleet-toml.ts` | Modify | `sweep`/`max_subjects`/`path_prefix` parsing; `SweepKind`; rules 3–5 |
| `packages/gateway/src/fleet/fleet-sweep-support.ts` | Create | `FLEET_SWEEP_SUPPORT` total map; `sweepParamFor`; `validateFleetSweepJobs` (rules 1, 2, 6) |
| `packages/gateway/src/fleet/fleet-sweep-enumerators.ts` | Create | The four enumerators + `buildFleetSweepEnumerate` |
| `packages/gateway/src/fleet/fleet-sweep-window.ts` | Create | `selectSweepWindow` — pure cursor selection |
| `packages/gateway/src/ownership/ownership-pass.ts` | Modify | Export `dirExternalId` (tests build nodes with the production id builders) |
| `packages/gateway/src/fleet/fleet-scheduler.ts` | Modify | `runSweepJob`; subject tally; `deps.enumerate` |
| `packages/gateway/src/platform/assemble.ts` | Modify | Call `validateFleetSweepJobs`; wire `buildFleetSweepEnumerate` |
| `packages/gateway/src/fleet/fleet-digest-types.ts` | Modify | `FleetSweepDigest`, `FleetSweepSubjectDigest`, `FleetDigestSubjectRef`; `sweeps` on result |
| `packages/gateway/src/fleet/fleet-digest.ts` | Modify | Sweep partition, per-subject comparison, `sweepSection` renderer |
| `packages/gateway/src/ipc/fleet-rpc.ts` | Modify | `fleet.briefs` `subjectKey`; `fleet.list` `sweep`; digest `retentionDays` |
| `packages/gateway/src/ipc/agents-rpc.ts` | Modify | `negotiate` eligibility comment → settled reason |
| `packages/cli/src/commands/fleet.ts` | Modify | `briefs --subject`; subject column; `list` sweep info; usage |
| Docs (Task 9) | Modify | architecture, roadmap, cli-reference, CHANGELOG, CLAUDE.md, GEMINI.md |

---

### Task 1: V63 migration and brief `subject_key`

**Files:**
- Create: `packages/gateway/src/index/fleet-subjects-v63-sql.ts`
- Modify: `packages/gateway/src/index/migrations/runner.ts` (import + step after line 571)
- Modify: `packages/gateway/src/index/local-index.ts:274`
- Modify: `packages/gateway/src/index/migrations/runner.test.ts:785-789` and add a V63 test
- Modify: `packages/gateway/src/fleet/fleet-store.ts` (`FleetBriefRow`, `recordBrief`, all brief SELECTs)
- Modify: `packages/gateway/src/fleet/fleet-scheduler.ts:246` (`recordBrief` call)
- Modify test setup in: `fleet/fleet-store.test.ts`, `fleet/fleet-scheduler.test.ts`, `fleet/fleet-digest.test.ts`, `ipc/fleet-rpc.test.ts`

**Interfaces:**
- Produces: `FLEET_SUBJECTS_V63_SQL: readonly string[]`; `FleetBriefRow.subjectKey: string`; `FleetStore.recordBrief({ …, subjectKey: string })` (REQUIRED).

- [ ] **Step 1: Write the failing runner test**

In `packages/gateway/src/index/migrations/runner.test.ts`, change the existing version pin test (currently `expect(CURRENT_SCHEMA_VERSION).toBe(62)` at line 788) to `63`, update its title to `"CURRENT_SCHEMA_VERSION is 63, so the newest step runs in production"`, and add after the `"V62 creates both vec_rowid join indexes through the runner"` test:

```ts
test("V63 rebuilds fleet_brief with subject_key, backfilled to job_id, cascade intact", () => {
  // The SQL constant being right does not prove the step is registered, and a table REBUILD is
  // exactly where an ON DELETE CASCADE silently disappears — both are asserted here, through the
  // runner, on a database that already holds a pre-V63 brief.
  const db = freshDb();
  db.run("PRAGMA foreign_keys = ON");
  runIndexedSchemaMigrations(db, 62);
  db.run(
    `INSERT INTO fleet_run (id, started_at, host_power, host_source) VALUES ('r1', 1, 'ac', 'measured')`,
  );
  db.run(
    `INSERT INTO fleet_brief (id, run_id, job_id, agent_method, findings_json, created_at, expires_at)
     VALUES ('b1', 'r1', 'nightly', 'agents.catchup', '{}', 1, 999)`,
  );

  runIndexedSchemaMigrations(db, 63);
  expect(userVersion(db)).toBe(63);

  const row = db.query("SELECT subject_key FROM fleet_brief WHERE id = 'b1'").get() as {
    subject_key: string;
  };
  expect(row.subject_key).toBe("nightly");

  const idx = (db.query("PRAGMA index_list(fleet_brief)").all() as Array<{ name: string }>).map(
    (r) => r.name,
  );
  expect(idx).toContain("idx_fleet_brief_job");
  expect(idx).toContain("idx_fleet_brief_subject");
  expect(idx).toContain("idx_fleet_brief_run");
  expect(idx).toContain("idx_fleet_brief_expires");

  const stateCols = (db.query("PRAGMA table_info(fleet_job_state)").all() as Array<{ name: string }>).map(
    (c) => c.name,
  );
  expect(stateCols).toEqual(
    expect.arrayContaining(["sweep_kind", "sweep_cursor", "sweep_subjects_total", "sweep_empty_reason"]),
  );
  const runCols = (db.query("PRAGMA table_info(fleet_run)").all() as Array<{ name: string }>).map(
    (c) => c.name,
  );
  expect(runCols).toEqual(
    expect.arrayContaining(["subjects_in_scope", "subjects_attempted", "subjects_completed"]),
  );

  db.run("DELETE FROM fleet_run WHERE id = 'r1'");
  const left = db.query("SELECT COUNT(*) AS n FROM fleet_brief").get() as { n: number };
  expect(left.n).toBe(0);
  db.close();
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `bun test packages/gateway/src/index/migrations/runner.test.ts -t "V63|CURRENT_SCHEMA_VERSION is 63"`
Expected: FAIL (`userVersion` is 62; the pin expects 63).

- [ ] **Step 3: Write the migration SQL**

Create `packages/gateway/src/index/fleet-subjects-v63-sql.ts`:

```ts
/**
 * V63 — fleet subject enumeration (S2 fleets PR 2b).
 *
 * `fleet_brief` gains `subject_key TEXT NOT NULL`. SQLite cannot add a NOT NULL column without a
 * default, and a default would write a placeholder into history, so the table is REBUILT (the V46
 * glossary precedent). The backfill `subject_key = job_id` is true history, not a stand-in: for a
 * config-named job the subject IS the job.
 *
 * The rebuild keeps `run_id … REFERENCES fleet_run(id) ON DELETE CASCADE` — a rebuild is where that
 * silently disappears — and `DROP TABLE` drops every index, so all four are recreated after the
 * rename. Columns are named explicitly, never `SELECT *`.
 *
 * `fleet_job_state` gains the sweep cursor (a KEY, not an ordinal: an ordinal shifts when a subject
 * is added or deleted). `fleet_run` gains subject counters so a run row stays self-describing when
 * one job produced many briefs.
 */
export const FLEET_SUBJECTS_V63_SQL: readonly string[] = [
  `CREATE TABLE IF NOT EXISTS fleet_brief_v63 (
     id              TEXT PRIMARY KEY,
     run_id          TEXT NOT NULL REFERENCES fleet_run(id) ON DELETE CASCADE,
     job_id          TEXT NOT NULL,
     subject_key     TEXT NOT NULL,
     agent_method    TEXT NOT NULL,
     brief_markdown  TEXT,
     findings_json   TEXT NOT NULL,
     synthesis_json  TEXT,
     created_at      INTEGER NOT NULL,
     expires_at      INTEGER NOT NULL
   ) WITHOUT ROWID`,
  `INSERT INTO fleet_brief_v63 (
     id, run_id, job_id, subject_key, agent_method, brief_markdown, findings_json,
     synthesis_json, created_at, expires_at
   )
   SELECT
     id, run_id, job_id, job_id, agent_method, brief_markdown, findings_json,
     synthesis_json, created_at, expires_at
   FROM fleet_brief`,
  "DROP TABLE fleet_brief",
  "ALTER TABLE fleet_brief_v63 RENAME TO fleet_brief",
  "CREATE INDEX IF NOT EXISTS idx_fleet_brief_run ON fleet_brief (run_id)",
  "CREATE INDEX IF NOT EXISTS idx_fleet_brief_job ON fleet_brief (job_id, subject_key, created_at DESC)",
  "CREATE INDEX IF NOT EXISTS idx_fleet_brief_subject ON fleet_brief (subject_key, created_at DESC)",
  "CREATE INDEX IF NOT EXISTS idx_fleet_brief_expires ON fleet_brief (expires_at)",
  "ALTER TABLE fleet_job_state ADD COLUMN sweep_kind TEXT",
  "ALTER TABLE fleet_job_state ADD COLUMN sweep_cursor TEXT",
  "ALTER TABLE fleet_job_state ADD COLUMN sweep_subjects_total INTEGER",
  "ALTER TABLE fleet_job_state ADD COLUMN sweep_empty_reason TEXT",
  "ALTER TABLE fleet_run ADD COLUMN subjects_in_scope INTEGER NOT NULL DEFAULT 0",
  "ALTER TABLE fleet_run ADD COLUMN subjects_attempted INTEGER NOT NULL DEFAULT 0",
  "ALTER TABLE fleet_run ADD COLUMN subjects_completed INTEGER NOT NULL DEFAULT 0",
];
```

- [ ] **Step 4: Register the step and bump the version**

In `packages/gateway/src/index/migrations/runner.ts`, add beside the V62 import (line 85):

```ts
import { FLEET_SUBJECTS_V63_SQL } from "../fleet-subjects-v63-sql.ts";
```

and after `simpleStep(61, 62, …)` (line 571):

```ts
  simpleStep(62, 63, "fleet subject enumeration (brief subject_key + sweep cursor)", FLEET_SUBJECTS_V63_SQL),
```

In `packages/gateway/src/index/local-index.ts:274`: `export const CURRENT_SCHEMA_VERSION = 63;`

- [ ] **Step 5: Run the runner tests to verify they pass**

Run: `bun test packages/gateway/src/index/migrations/runner.test.ts`
Expected: PASS, including "CURRENT_SCHEMA_VERSION tracks the highest registered migration step".

- [ ] **Step 6: Make the fleet test schemas current**

The four fleet test files build their schema with `db.exec(FLEET_V60_SQL)`. Once the store writes `subject_key` they must also apply V63. In EACH of `fleet/fleet-store.test.ts`, `fleet/fleet-scheduler.test.ts`, `fleet/fleet-digest.test.ts`, `ipc/fleet-rpc.test.ts`, add the import:

```ts
import { FLEET_SUBJECTS_V63_SQL } from "../index/fleet-subjects-v63-sql.ts";
```

and immediately after every `db.exec(FLEET_V60_SQL);` line add:

```ts
  for (const stmt of FLEET_SUBJECTS_V63_SQL) db.exec(stmt);
```

Find every site with: `rg -n "db.exec\(FLEET_V60_SQL\)" packages/gateway/src`

- [ ] **Step 7: Write the failing store test for `subjectKey`**

Both `fleet/fleet-store.test.ts` (module-level `insertBrief`) and `fleet/fleet-digest.test.ts` (the `insertBrief` defined inside its digest `describe`, ~line 180) have an `insertBrief` helper. In BOTH, add `subjectKey?: string` to the parameter type and pass `subjectKey: b.subjectKey ?? b.jobId` to `recordBrief`. Add inside `describe("FleetStore", …)` in the store test:

```ts
  test("a brief round-trips its subject key through every read", () => {
    const runId = store.openRun({
      startedAt: 1000,
      hostPower: "ac",
      hostIdleMs: 0,
      hostSource: "measured",
      remoteCallBudget: 0,
    });
    const id = store.recordBrief({
      runId,
      jobId: "bus-factor",
      subjectKey: "paths:file:/r:src/a.ts",
      agentMethod: "agents.ownership",
      briefMarkdown: "x",
      findingsJson: "{}",
      synthesisJson: null,
      createdAt: 1100,
      expiresAt: 1100 + 86_400_000,
    });
    expect(store.getBrief(id, 1200)?.subjectKey).toBe("paths:file:/r:src/a.ts");
    expect(store.listBriefs({ limit: 5, now: 1200 })[0]?.subjectKey).toBe("paths:file:/r:src/a.ts");
  });
```

Every other `store.recordBrief({` call in the four test files gains `subjectKey: <its jobId value>`. Find them: `rg -n "recordBrief\(\{" packages/gateway/src`

- [ ] **Step 8: Run it to verify it fails**

Run: `bun test packages/gateway/src/fleet/fleet-store.test.ts -t "round-trips its subject key"`
Expected: FAIL (typecheck-level: `subjectKey` not in `recordBrief`'s parameter / `undefined` on the row).

- [ ] **Step 9: Implement `subjectKey` in the store**

In `packages/gateway/src/fleet/fleet-store.ts`:

1. Add `readonly subjectKey: string;` to `FleetBriefRow` after `jobId`.
2. Add a private row type and ONE mapper, replacing the three duplicated inline mappings in `listBriefs`, `getBrief`, `queryOne`:

```ts
type FleetBriefDbRow = {
  id: string;
  run_id: string;
  job_id: string;
  subject_key: string;
  agent_method: string;
  brief_markdown: string | null;
  findings_json: string;
  synthesis_json: string | null;
  created_at: number;
};

function toBriefRow(r: FleetBriefDbRow): FleetBriefRow {
  return {
    id: r.id,
    runId: r.run_id,
    jobId: r.job_id,
    subjectKey: r.subject_key,
    agentMethod: r.agent_method,
    briefMarkdown: r.brief_markdown,
    findingsJson: r.findings_json,
    synthesisJson: r.synthesis_json,
    createdAt: r.created_at,
  };
}
```

3. Every brief `SELECT` column list (`listBriefs` both arms, `getBrief`, `BRIEF_COLS`) becomes
`id, run_id, job_id, subject_key, agent_method, brief_markdown, findings_json, synthesis_json, created_at`, cast to `FleetBriefDbRow` / `ReadonlyArray<FleetBriefDbRow>` / `FleetBriefDbRow | null`, and mapped with `toBriefRow`.
4. `recordBrief` gains a REQUIRED `subjectKey: string` parameter field; the INSERT column list gains `subject_key` after `job_id` and the values array gains `b.subjectKey` in the same position.

In `packages/gateway/src/fleet/fleet-scheduler.ts` `runOneJob` (line 246), add `subjectKey: job.name,` after `jobId: job.name,`.

- [ ] **Step 10: Run the fleet suites and typecheck**

Run: `bun test packages/gateway/src/fleet packages/gateway/src/ipc/fleet-rpc.test.ts packages/gateway/src/index/migrations/runner.test.ts && bun run typecheck`
Expected: all PASS, typecheck clean.

- [ ] **Step 11: Commit**

```bash
git rev-parse --abbrev-ref HEAD   # must print dev/asafgolombek/fleet-subject-enumeration
git add packages/gateway/src/index packages/gateway/src/fleet packages/gateway/src/ipc/fleet-rpc.test.ts
git commit -F <msgfile>   # "feat(fleet): V63 — subject_key on fleet briefs, sweep state columns"
```

---

### Task 2: Store — subject-scoped reads, sweep state, subject counters

**Files:**
- Modify: `packages/gateway/src/fleet/fleet-store.ts`
- Modify: `packages/gateway/src/fleet/fleet-digest.ts:132` (call site rename)
- Test: `packages/gateway/src/fleet/fleet-store.test.ts`

**Interfaces:**
- Consumes: Task 1's columns and `FleetBriefRow.subjectKey`.
- Produces:
  - `export interface FleetSweepState { readonly kind: string | null; readonly cursor: string | null; readonly subjectsTotal: number | null; readonly emptyReason: string | null }`
  - `FleetStore.loadSweepState(jobId: string): FleetSweepState | undefined`
  - `FleetStore.recordSweepEnumeration(jobId: string, e: { kind: string; subjectsTotal: number; emptyReason: string | null }): void` — resets the cursor to NULL when `kind` differs from the stored kind.
  - `FleetStore.advanceSweepCursor(jobId: string, kind: string, key: string): void`
  - `FleetStore.briefPairForSubject(q: { jobId: string; subjectKey: string; windowStartMs: number; now: number }): { current: FleetBriefRow | undefined; predecessor: FleetBriefRow | undefined }` (REPLACES `briefPairForJob`)
  - `FleetStore.subjectKeysWithBriefsInWindow(q: { jobId: string; windowStartMs: number; now: number }): string[]` (sorted `codeUnitCompare`)
  - `FleetStore.listBriefs(q: { limit: number; jobId?: string; subjectKey?: string; now: number })`
  - `FleetStore.closeRun` gains REQUIRED `subjectsInScope`, `subjectsAttempted`, `subjectsCompleted`.

- [ ] **Step 1: Write the failing tests**

Add to `fleet/fleet-store.test.ts`:

```ts
describe("sweep state", () => {
  test("enumeration records kind/total/reason; the cursor advances by key", () => {
    store.recordSweepEnumeration("bus", { kind: "paths", subjectsTotal: 3, emptyReason: null });
    store.advanceSweepCursor("bus", "paths", "paths:file:/r:b.ts");
    expect(store.loadSweepState("bus")).toEqual({
      kind: "paths",
      cursor: "paths:file:/r:b.ts",
      subjectsTotal: 3,
      emptyReason: null,
    });
  });

  test("a re-enumeration of the SAME kind keeps the cursor", () => {
    store.recordSweepEnumeration("bus", { kind: "paths", subjectsTotal: 3, emptyReason: null });
    store.advanceSweepCursor("bus", "paths", "paths:k2");
    store.recordSweepEnumeration("bus", { kind: "paths", subjectsTotal: 4, emptyReason: null });
    expect(store.loadSweepState("bus")?.cursor).toBe("paths:k2");
    expect(store.loadSweepState("bus")?.subjectsTotal).toBe(4);
  });

  test("a CHANGED kind resets the cursor rather than comparing keys of another kind", () => {
    store.recordSweepEnumeration("bus", { kind: "paths", subjectsTotal: 3, emptyReason: null });
    store.advanceSweepCursor("bus", "paths", "paths:k2");
    store.recordSweepEnumeration("bus", { kind: "services", subjectsTotal: 1, emptyReason: null });
    expect(store.loadSweepState("bus")?.cursor).toBeNull();
    expect(store.loadSweepState("bus")?.kind).toBe("services");
  });

  test("(red-prove) recordJobSuccess and recordJobFailure leave sweep columns untouched", () => {
    // Both statements use ON CONFLICT DO UPDATE SET with an explicit column list, which leaves
    // unlisted columns alone. Pinned because the next edit to either statement is where it breaks.
    store.recordSweepEnumeration("bus", { kind: "paths", subjectsTotal: 7, emptyReason: "x" });
    store.advanceSweepCursor("bus", "paths", "paths:k5");
    store.recordJobSuccess("bus", 10);
    store.recordJobFailure("bus", 20, "boom");
    expect(store.loadSweepState("bus")).toEqual({
      kind: "paths",
      cursor: "paths:k5",
      subjectsTotal: 7,
      emptyReason: "x",
    });
  });
});

describe("subject-scoped brief reads", () => {
  test("briefPairForSubject pairs within ONE subject, never across subjects of a job", () => {
    insertBrief({ jobId: "bus", subjectKey: "paths:a", createdAt: 100 });
    insertBrief({ jobId: "bus", subjectKey: "paths:b", createdAt: 150 });
    insertBrief({ jobId: "bus", subjectKey: "paths:a", createdAt: 5000 });
    const pair = store.briefPairForSubject({
      jobId: "bus",
      subjectKey: "paths:a",
      windowStartMs: 1000,
      now: 6000,
    });
    expect(pair.current?.createdAt).toBe(5000);
    expect(pair.predecessor?.createdAt).toBe(100);
    expect(pair.predecessor?.subjectKey).toBe("paths:a");
  });

  test("subjectKeysWithBriefsInWindow is distinct and code-unit sorted", () => {
    insertBrief({ jobId: "bus", subjectKey: "paths:b", createdAt: 2000 });
    insertBrief({ jobId: "bus", subjectKey: "paths:a", createdAt: 2001 });
    insertBrief({ jobId: "bus", subjectKey: "paths:a", createdAt: 2002 });
    insertBrief({ jobId: "other", subjectKey: "paths:z", createdAt: 2003 });
    expect(
      store.subjectKeysWithBriefsInWindow({ jobId: "bus", windowStartMs: 1000, now: 3000 }),
    ).toEqual(["paths:a", "paths:b"]);
  });

  test("listBriefs filters by subjectKey across jobs", () => {
    insertBrief({ jobId: "j1", subjectKey: "services:checkout", createdAt: 2000 });
    insertBrief({ jobId: "j2", subjectKey: "services:checkout", createdAt: 2001 });
    insertBrief({ jobId: "j2", subjectKey: "services:billing", createdAt: 2002 });
    const rows = store.listBriefs({ limit: 10, subjectKey: "services:checkout", now: 3000 });
    expect(rows.map((r) => r.jobId).sort()).toEqual(["j1", "j2"]);
  });

  test("closeRun persists subject counters", () => {
    const runId = store.openRun({
      startedAt: 1,
      hostPower: "ac",
      hostIdleMs: 0,
      hostSource: "measured",
      remoteCallBudget: 0,
    });
    store.closeRun(runId, {
      endedAt: 2,
      outcome: "completed",
      jobsInScope: 1,
      jobsAttempted: 1,
      jobsCompleted: 1,
      jobsSkippedNotDue: 0,
      remoteCallsMade: 0,
      subjectsInScope: 4,
      subjectsAttempted: 4,
      subjectsCompleted: 3,
    });
    const row = db
      .query("SELECT subjects_in_scope, subjects_attempted, subjects_completed FROM fleet_run WHERE id = ?")
      .get(runId) as { subjects_in_scope: number; subjects_attempted: number; subjects_completed: number };
    expect(row).toEqual({ subjects_in_scope: 4, subjects_attempted: 4, subjects_completed: 3 });
  });
});
```

Rename every existing `briefPairForJob({ jobId: X, …})` call in the test file to `briefPairForSubject({ jobId: X, subjectKey: X, …})`, and add the three `subjects*: 0` fields to every existing `closeRun` call in it.

- [ ] **Step 2: Run to verify failure**

Run: `bun test packages/gateway/src/fleet/fleet-store.test.ts`
Expected: FAIL (`recordSweepEnumeration` / `briefPairForSubject` / `subjectKeysWithBriefsInWindow` undefined).

- [ ] **Step 3: Implement**

In `packages/gateway/src/fleet/fleet-store.ts` add the import `import { codeUnitCompare } from "../util/code-unit-compare.ts";` and:

```ts
export interface FleetSweepState {
  readonly kind: string | null;
  readonly cursor: string | null;
  readonly subjectsTotal: number | null;
  readonly emptyReason: string | null;
}
```

Methods on `FleetStore`:

```ts
  loadSweepState(jobId: string): FleetSweepState | undefined {
    const row = this.db
      .query(
        `SELECT sweep_kind, sweep_cursor, sweep_subjects_total, sweep_empty_reason
           FROM fleet_job_state WHERE job_id = ?`,
      )
      .get(jobId) as {
      sweep_kind: string | null;
      sweep_cursor: string | null;
      sweep_subjects_total: number | null;
      sweep_empty_reason: string | null;
    } | null;
    if (row === null) return undefined;
    return {
      kind: row.sweep_kind,
      cursor: row.sweep_cursor,
      subjectsTotal: row.sweep_subjects_total,
      emptyReason: row.sweep_empty_reason,
    };
  }

  /**
   * The ONE writer of the enumeration half of sweep state. A changed kind resets the cursor: keys of
   * one kind are not comparable with another's. SQLite evaluates every SET expression against the
   * PRE-update row, so the CASE reads the old `sweep_kind` even though `sweep_kind` is also assigned.
   */
  recordSweepEnumeration(
    jobId: string,
    e: { kind: string; subjectsTotal: number; emptyReason: string | null },
  ): void {
    dbRun(
      this.db,
      `INSERT INTO fleet_job_state (job_id, sweep_kind, sweep_cursor, sweep_subjects_total, sweep_empty_reason)
       VALUES (?, ?, NULL, ?, ?)
       ON CONFLICT(job_id) DO UPDATE SET
         sweep_cursor = CASE WHEN fleet_job_state.sweep_kind IS excluded.sweep_kind
                             THEN fleet_job_state.sweep_cursor ELSE NULL END,
         sweep_kind = excluded.sweep_kind,
         sweep_subjects_total = excluded.sweep_subjects_total,
         sweep_empty_reason = excluded.sweep_empty_reason`,
      [jobId, e.kind, e.subjectsTotal, e.emptyReason],
    );
  }

  /** Scoped to the kind, so a cursor can never be written under a kind it was not selected from. */
  advanceSweepCursor(jobId: string, kind: string, key: string): void {
    dbRun(
      this.db,
      `UPDATE fleet_job_state SET sweep_cursor = ? WHERE job_id = ? AND sweep_kind = ?`,
      [key, jobId, kind],
    );
  }

  subjectKeysWithBriefsInWindow(q: { jobId: string; windowStartMs: number; now: number }): string[] {
    const rows = this.db
      .query(
        `SELECT DISTINCT subject_key FROM fleet_brief
          WHERE job_id = ? AND created_at >= ? AND created_at <= ? AND expires_at > ?`,
      )
      .all(q.jobId, q.windowStartMs, q.now, q.now) as ReadonlyArray<{ subject_key: string }>;
    // Sorted in JS: SQLite's BINARY collation compares UTF-8 bytes, `codeUnitCompare` UTF-16 code
    // units, and the two disagree above the BMP — the digest must order identically everywhere.
    return rows.map((r) => r.subject_key).sort(codeUnitCompare);
  }
```

Replace `briefPairForJob` with `briefPairForSubject`. Keep its existing doc comment and the three inline comments (the future-dated-row comment above `current`, the id-not-timestamp comment above `oldestInWindow`), adding one sentence to the doc comment: "Scoped to one subject: a sweep job's subjects are compared only with themselves." All THREE queries carry `subject_key = ?` — the third is the one easiest to miss, since it only runs when nothing precedes the window:

```ts
  briefPairForSubject(q: { jobId: string; subjectKey: string; windowStartMs: number; now: number }): {
    current: FleetBriefRow | undefined;
    predecessor: FleetBriefRow | undefined;
  } {
    const current = this.queryOne(
      `WHERE job_id = ? AND subject_key = ? AND created_at >= ? AND created_at <= ? AND expires_at > ?
       ORDER BY created_at DESC, id DESC LIMIT 1`,
      [q.jobId, q.subjectKey, q.windowStartMs, q.now, q.now],
    );
    if (current === undefined) return { current: undefined, predecessor: undefined };
    const before = this.queryOne(
      `WHERE job_id = ? AND subject_key = ? AND created_at < ? AND expires_at > ?
       ORDER BY created_at DESC, id DESC LIMIT 1`,
      [q.jobId, q.subjectKey, q.windowStartMs, q.now],
    );
    if (before !== undefined) return { current, predecessor: before };
    const oldestInWindow = this.queryOne(
      `WHERE job_id = ? AND subject_key = ? AND created_at >= ? AND created_at <= ? AND id != ? AND expires_at > ?
       ORDER BY created_at ASC, id ASC LIMIT 1`,
      [q.jobId, q.subjectKey, q.windowStartMs, current.createdAt, current.id, q.now],
    );
    return { current, predecessor: oldestInWindow };
  }
```

Add a store test for the third query specifically:

```ts
  test("(red-prove) the oldest-in-window fallback is subject-scoped too", () => {
    // Nothing precedes the window, so the pair falls back to the OLDEST brief inside it. Without
    // `subject_key = ?` on that query, subject a's predecessor would be subject b's earlier brief.
    insertBrief({ jobId: "bus", subjectKey: "paths:b", createdAt: 1100 });
    insertBrief({ jobId: "bus", subjectKey: "paths:a", createdAt: 1200 });
    insertBrief({ jobId: "bus", subjectKey: "paths:a", createdAt: 1500 });
    const pair = store.briefPairForSubject({
      jobId: "bus",
      subjectKey: "paths:a",
      windowStartMs: 1000,
      now: 2000,
    });
    expect(pair.current?.createdAt).toBe(1500);
    expect(pair.predecessor?.createdAt).toBe(1200);
    expect(pair.predecessor?.subjectKey).toBe("paths:a");
  });
```

Red-prove it by removing `subject_key = ? AND` (and `q.subjectKey`) from the third query only; confirm it FAILS (predecessor is 1100, subject b); restore.

`listBriefs`: replace the two-arm query with one built WHERE:

```ts
  listBriefs(q: { limit: number; jobId?: string; subjectKey?: string; now: number }): FleetBriefRow[] {
    const where: string[] = ["expires_at > ?"];
    const params: (string | number)[] = [q.now];
    if (q.jobId !== undefined) {
      where.push("job_id = ?");
      params.push(q.jobId);
    }
    if (q.subjectKey !== undefined) {
      where.push("subject_key = ?");
      params.push(q.subjectKey);
    }
    params.push(q.limit);
    const rows = this.db
      .query(`${FleetStore.BRIEF_COLS}WHERE ${where.join(" AND ")} ORDER BY created_at DESC LIMIT ?`)
      .all(...params) as ReadonlyArray<FleetBriefDbRow>;
    return rows.map(toBriefRow);
  }
```

(`where` holds only literal fragments; every value is a bound parameter — I9.) Keep the existing doc comment. `BRIEF_COLS` must be declared before use — move it above `listBriefs` if needed.

`closeRun`: add the three required fields with a doc comment "Subjects are units of brief production: a config-named job is one, a sweep job its window." and extend the UPDATE: `…, remote_calls_made = ?, subjects_in_scope = ?, subjects_attempted = ?, subjects_completed = ? WHERE id = ?` with values in that order.

- [ ] **Step 4: Fix the two call sites**

`fleet/fleet-digest.ts:132`: `deps.store.briefPairForSubject({ jobId, subjectKey: jobId, windowStartMs, now: deps.now })`.
Then `rg -n "briefPairForJob" packages docs` must print nothing: comments that name the old method (e.g. `fleet-digest.test.ts` ~line 216, `fleet-store.ts`'s `jobIdsWithBriefsInWindow` doc) are updated too — a comment naming a method that no longer exists is a false attestation.
`fleet/fleet-scheduler.ts` `close`: pass `subjectsInScope: 0, subjectsAttempted: 0, subjectsCompleted: 0` to `closeRun`. These are placeholders only between Task 2 and Task 6, which replaces them with the tally in the same function; add no comment referring to the plan.

- [ ] **Step 5: Run tests; red-prove**

Run: `bun test packages/gateway/src/fleet && bun run typecheck`
Expected: PASS. **Red-prove** the preservation test: temporarily add `sweep_cursor = NULL,` to `recordJobSuccess`'s `DO UPDATE SET`; confirm the test FAILS; restore.

- [ ] **Step 6: Commit** — `feat(fleet): subject-scoped brief reads and sweep cursor state`

---

### Task 3: Config — `sweep`, `max_subjects`, `path_prefix` (rules 3–5)

**Files:**
- Modify: `packages/gateway/src/config/fleet-toml.ts`
- Test: `packages/gateway/src/config/fleet-toml.test.ts`
- Modify (mechanical `sweep: null`): every `NimbusFleetJobToml` literal — `fleet/fleet-invoker.test.ts`, `fleet/fleet-scheduler.test.ts`, `ipc/fleet-rpc.test.ts`, `security-invariants.test.ts`, `config/fleet-toml.test.ts`

**Interfaces:**
- Produces:
  - `export const SWEEP_KINDS = ["paths", "services", "symbols", "terms"] as const;`
  - `export type SweepKind = (typeof SWEEP_KINDS)[number];`
  - `export const MAX_SWEEP_SUBJECTS = 500;`
  - `export interface FleetJobSweepToml { readonly kind: SweepKind; readonly maxSubjects: number; readonly pathPrefix: string | null }`
  - `NimbusFleetJobToml.sweep: FleetJobSweepToml | null` (REQUIRED)

- [ ] **Step 1: Write failing tests**

Add to `config/fleet-toml.test.ts`:

```ts
describe("[[fleet.job]] sweep", () => {
  const base = `[[fleet.job]]\nname = "bus"\nagent = "ownership"\ninterval_seconds = 86400\n`;

  test("parses sweep, max_subjects and path_prefix, none of which reach params", () => {
    const [job] = parseNimbusTomlFleetJobs(
      `${base}sweep = "paths"\nmax_subjects = 200\npath_prefix = "packages/"\n`,
    );
    expect(job?.sweep).toEqual({ kind: "paths", maxSubjects: 200, pathPrefix: "packages/" });
    expect(job?.params).toEqual({});
  });

  test("a job without sweep has sweep: null", () => {
    expect(parseNimbusTomlFleetJobs(base)[0]?.sweep).toBeNull();
  });

  test.each([
    ["absent", ""],
    ["zero", "max_subjects = 0\n"],
    ["above 500 (refused, not clamped)", "max_subjects = 501\n"],
    ["non-integer", 'max_subjects = "lots"\n'],
  ])("rule 3: sweep with max_subjects %s is refused", (_label, line) => {
    expect(() => parseNimbusTomlFleetJobs(`${base}sweep = "paths"\n${line}`)).toThrow(
      /bus requires max_subjects between 1 and 500/,
    );
  });

  test("rule 4: max_subjects without sweep is refused", () => {
    expect(() => parseNimbusTomlFleetJobs(`${base}max_subjects = 5\n`)).toThrow(/without sweep/);
  });

  test("rule 4: path_prefix without sweep is refused", () => {
    expect(() => parseNimbusTomlFleetJobs(`${base}path_prefix = "src/"\n`)).toThrow(/without sweep/);
  });

  test("rule 5: path_prefix on a kind that does not accept it is refused", () => {
    expect(() =>
      parseNimbusTomlFleetJobs(`${base}sweep = "services"\nmax_subjects = 5\npath_prefix = "x"\n`),
    ).toThrow(/path_prefix applies only to sweep = "paths" or "symbols"/);
  });

  test("an EMPTY path_prefix is refused, not read as 'no filter'", () => {
    // `""` prefixes every path, so it would silently mean "no narrowing" — a value the owner wrote
    // that does nothing. Refused like `digest_min_delta = 0`. NOT trimmed: a repo-relative path may
    // legally contain spaces, and trimming would silently change what the owner asked for.
    expect(() =>
      parseNimbusTomlFleetJobs(`${base}sweep = "paths"\nmax_subjects = 5\npath_prefix = ""\n`),
    ).toThrow(/bus path_prefix must not be empty/);
  });

  test("path_prefix whitespace is preserved verbatim", () => {
    const [job] = parseNimbusTomlFleetJobs(
      `${base}sweep = "paths"\nmax_subjects = 5\npath_prefix = "my docs/"\n`,
    );
    expect(job?.sweep?.pathPrefix).toBe("my docs/");
  });

  test("an unknown sweep kind is refused and names the valid set", () => {
    expect(() =>
      parseNimbusTomlFleetJobs(`${base}sweep = "people"\nmax_subjects = 5\n`),
    ).toThrow(/unknown sweep "people".*paths, services, symbols, terms/);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `bun test packages/gateway/src/config/fleet-toml.test.ts -t sweep`
Expected: FAIL.

- [ ] **Step 3: Implement**

In `packages/gateway/src/config/fleet-toml.ts`:

```ts
export const SWEEP_KINDS = ["paths", "services", "symbols", "terms"] as const;
export type SweepKind = (typeof SWEEP_KINDS)[number];

/** A sweep's per-run cap ceiling — refused above, never clamped (the `media allow-remote --limit` posture). */
export const MAX_SWEEP_SUBJECTS = 500;

/** Kinds whose subjects carry a repo-relative path `path_prefix` can match. */
const PATH_PREFIX_KINDS: ReadonlySet<SweepKind> = new Set<SweepKind>(["paths", "symbols"]);

export interface FleetJobSweepToml {
  readonly kind: SweepKind;
  readonly maxSubjects: number;
  readonly pathPrefix: string | null;
}

function isSweepKind(s: string): s is SweepKind {
  return (SWEEP_KINDS as readonly string[]).includes(s);
}
```

`NimbusFleetJobToml` gains `readonly sweep: FleetJobSweepToml | null;` after `digestMinDelta`.
`JOB_RESERVED` becomes `new Set(["name", "agent", "interval_seconds", "digest_min_delta", "sweep", "max_subjects", "path_prefix"])`.
`FleetJobDraft` gains `sweep?: string; maxSubjectsRaw?: string; pathPrefix?: string;`.
In `applyJobKey`, before the `if (!JOB_RESERVED.has(key))` fallback:

```ts
  if (key === "sweep") {
    cur.sweep = parseString(valRaw);
    return;
  }
  if (key === "max_subjects") {
    // Kept RAW: validity depends on whether `sweep` is set, which a later line may decide.
    cur.maxSubjectsRaw = valRaw;
    return;
  }
  if (key === "path_prefix") {
    cur.pathPrefix = parseString(valRaw);
    return;
  }
```

Add the resolver:

```ts
/**
 * Rules 3–5 of the sweep spec (§ 4) — the syntactic half. Rules 1, 2 and 6 need the agent map and
 * run in `fleet/fleet-sweep-support.ts`, since `config/` does not import `fleet/`.
 */
function resolveSweep(name: string, d: FleetJobDraft): FleetJobSweepToml | null {
  if (d.sweep === undefined) {
    if (d.maxSubjectsRaw !== undefined || d.pathPrefix !== undefined) {
      throw new FleetConfigError(
        `[[fleet.job]] ${name} sets max_subjects or path_prefix without sweep`,
      );
    }
    return null;
  }
  const kind = d.sweep;
  if (!isSweepKind(kind)) {
    throw new FleetConfigError(
      `[[fleet.job]] ${name} has unknown sweep "${kind}" (expected one of ${SWEEP_KINDS.join(", ")})`,
    );
  }
  const n = d.maxSubjectsRaw === undefined ? undefined : parseIntDec(d.maxSubjectsRaw);
  if (n === undefined || n < 1 || n > MAX_SWEEP_SUBJECTS) {
    throw new FleetConfigError(
      `[[fleet.job]] ${name} requires max_subjects between 1 and ${String(MAX_SWEEP_SUBJECTS)} ` +
        `when sweep is set (refused, not clamped; an unbounded sweep must not be expressible)`,
    );
  }
  if (d.pathPrefix === "") {
    // Every path starts with "", so an empty prefix would silently mean "no narrowing". Refused, not
    // trimmed or dropped: a path may legally contain spaces, so whitespace is kept verbatim.
    throw new FleetConfigError(`[[fleet.job]] ${name} path_prefix must not be empty`);
  }
  if (d.pathPrefix !== undefined && !PATH_PREFIX_KINDS.has(kind)) {
    throw new FleetConfigError(
      `[[fleet.job]] ${name} path_prefix applies only to sweep = "paths" or "symbols"`,
    );
  }
  return { kind, maxSubjects: n, pathPrefix: d.pathPrefix ?? null };
}
```

In `flush`, destructure the draft as `const draft = cur;` before `cur = undefined;`, and push `{ name, agent, intervalSeconds, params, digestMinDelta: digestMinDelta ?? 1, sweep: resolveSweep(name, draft) }` — `resolveSweep` runs AFTER the name/agent/interval/duplicate checks so their existing messages are unchanged.

- [ ] **Step 4: Update every job literal**

Run `bun run typecheck`; for each reported `NimbusFleetJobToml` literal missing `sweep`, add `sweep: null` after `digestMinDelta`. Expected sites (verify with `rg -n "digestMinDelta" packages/gateway/src --glob "*.test.ts"`): `fleet/fleet-invoker.test.ts` (1), `fleet/fleet-scheduler.test.ts` (9), `ipc/fleet-rpc.test.ts` (4), `security-invariants.test.ts` (1), `fleet/fleet-digest.test.ts` (the `job()` helper at ~line 137: `return { name, agent, intervalSeconds: 3600, params: {}, digestMinDelta, sweep: null };`), `config/fleet-toml.test.ts` (existing `toEqual` expectations gain `sweep: null`).

- [ ] **Step 5: Run and commit**

Run: `bun test packages/gateway/src/config/fleet-toml.test.ts packages/gateway/src/fleet packages/gateway/src/ipc/fleet-rpc.test.ts && bun run typecheck`
Expected: PASS.
Commit: `feat(fleet): parse sweep, max_subjects and path_prefix on fleet jobs`

---

### Task 4: The sweep support map and load-time validation (rules 1, 2, 6)

**Files:**
- Create: `packages/gateway/src/fleet/fleet-sweep-support.ts`
- Test: `packages/gateway/src/fleet/fleet-sweep-support.test.ts`
- Modify: `packages/gateway/src/platform/assemble.ts:3049` (validate inside the parse `try`)
- Modify: `packages/gateway/src/ipc/agents-rpc.ts` (`agents.negotiate` comment in `FLEET_ELIGIBILITY`)

**Interfaces:**
- Consumes: `SweepKind`, `NimbusFleetJobToml`, `FleetConfigError` (Task 3); `EligibleAgentMethod` (`fleet/fleet-digest-types.ts`); `resolveFleetAgentMethod`, `FLEET_ELIGIBILITY` (`ipc/agents-rpc.ts`).
- Produces:
  - `export type SweepSubjectParam = "path" | "service" | "file" | "term";`
  - `export interface SweepSupport { readonly accepts: Readonly<Partial<Record<SweepKind, SweepSubjectParam>>>; readonly reason: string | null }`
  - `export const FLEET_SWEEP_SUPPORT` (satisfies `Readonly<Record<EligibleAgentMethod, SweepSupport>>`)
  - `export function sweepSupportFor(agent: string): SweepSupport | null`
  - `export function sweepParamFor(agent: string, kind: SweepKind): SweepSubjectParam | null`
  - `export function validateFleetSweepJobs(jobs: readonly NimbusFleetJobToml[]): void`

- [ ] **Step 1: Write failing tests**

Create `packages/gateway/src/fleet/fleet-sweep-support.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import type { NimbusFleetJobToml } from "../config/fleet-toml.ts";
import { FleetConfigError } from "../config/fleet-toml.ts";
import { FLEET_ELIGIBILITY } from "../ipc/agents-rpc.ts";
import {
  FLEET_SWEEP_SUPPORT,
  sweepParamFor,
  validateFleetSweepJobs,
} from "./fleet-sweep-support.ts";

function job(over: Partial<NimbusFleetJobToml> & Pick<NimbusFleetJobToml, "agent">): NimbusFleetJobToml {
  return {
    name: "j",
    intervalSeconds: 60,
    params: {},
    digestMinDelta: 1,
    sweep: { kind: "paths", maxSubjects: 10, pathPrefix: null },
    ...over,
  };
}

describe("FLEET_SWEEP_SUPPORT", () => {
  test("covers EXACTLY the fleet-eligible agents — derived from FLEET_ELIGIBILITY, not a hand list", () => {
    const eligible = Object.entries(FLEET_ELIGIBILITY)
      .filter(([, v]) => v === "eligible")
      .map(([k]) => k)
      .sort();
    expect(Object.keys(FLEET_SWEEP_SUPPORT).sort()).toEqual(eligible);
  });

  test("every entry is either sweepable with no reason, or not sweepable with a reason", () => {
    for (const [method, s] of Object.entries(FLEET_SWEEP_SUPPORT)) {
      const kinds = Object.keys(s.accepts);
      if (kinds.length > 0) expect(s.reason, method).toBeNull();
      else expect(typeof s.reason === "string" && s.reason.length > 0, method).toBe(true);
    }
  });

  test("the verified bindings (spec § 5.2)", () => {
    expect(sweepParamFor("ownership", "paths")).toBe("path");
    expect(sweepParamFor("ownership", "services")).toBe("service");
    expect(sweepParamFor("oncall", "services")).toBe("service");
    expect(sweepParamFor("changelog", "services")).toBe("service");
    expect(sweepParamFor("ghost", "symbols")).toBe("file");
    expect(sweepParamFor("conflicts", "symbols")).toBe("file");
    expect(sweepParamFor("glossary", "terms")).toBe("term");
    expect(sweepParamFor("janitor", "paths")).toBeNull();
    expect(sweepParamFor("ghost", "paths")).toBeNull();
    expect(sweepParamFor("negotiate", "services")).toBeNull();
  });
});

describe("validateFleetSweepJobs", () => {
  test("accepts config-named jobs and valid sweeps", () => {
    expect(() =>
      validateFleetSweepJobs([
        job({ agent: "catchup", sweep: null }),
        job({ agent: "ownership" }),
      ]),
    ).not.toThrow();
  });

  test("rule 1: a kind the agent does not accept is refused, with the map's reason", () => {
    expect(() => validateFleetSweepJobs([job({ agent: "janitor" })])).toThrow(FleetConfigError);
    expect(() => validateFleetSweepJobs([job({ agent: "janitor" })])).toThrow(/no resource inventory/);
    expect(() =>
      validateFleetSweepJobs([job({ agent: "ghost", sweep: { kind: "paths", maxSubjects: 5, pathPrefix: null } })]),
    ).toThrow(/cannot sweep "paths"/);
  });

  test("rule 2: the job also setting the swept parameter is refused", () => {
    expect(() =>
      validateFleetSweepJobs([job({ agent: "ownership", params: { path: "src" } })]),
    ).toThrow(/sets path and sweep = "paths"/);
  });

  test.each([["namespace"], ["namespaces"]])(
    "rule 6: sweep with %s is refused — a sweep stays local",
    (key) => {
      expect(() =>
        validateFleetSweepJobs([
          job({
            agent: "ghost",
            params: { [key]: "team-a" },
            sweep: { kind: "symbols", maxSubjects: 5, pathPrefix: null },
          }),
        ]),
      ).toThrow(/a sweep stays local/);
    },
  );
});
```

- [ ] **Step 2: Run to verify failure**

Run: `bun test packages/gateway/src/fleet/fleet-sweep-support.test.ts`
Expected: FAIL (module not found).

- [ ] **Step 3: Implement**

Create `packages/gateway/src/fleet/fleet-sweep-support.ts`:

```ts
import type { NimbusFleetJobToml, SweepKind } from "../config/fleet-toml.ts";
import { FleetConfigError } from "../config/fleet-toml.ts";
import { resolveFleetAgentMethod } from "../ipc/agents-rpc.ts";
import type { EligibleAgentMethod } from "./fleet-digest-types.ts";

/** The agent parameter a sweep subject fills. */
export type SweepSubjectParam = "path" | "service" | "file" | "term";

/**
 * How one eligible agent can be swept. ONE interface rather than a union: indexing a union of record
 * shapes by `SweepKind` needs an assertion to read. The two states are still exclusive — a non-empty
 * `accepts` with `reason: null`, or an empty `accepts` with a reason — pinned by a test over every
 * entry. The kind → parameter binding IS the entry, so a kind cannot be accepted without naming the
 * parameter it fills.
 */
export interface SweepSupport {
  readonly accepts: Readonly<Partial<Record<SweepKind, SweepSubjectParam>>>;
  readonly reason: string | null;
}

const NOT_SWEEPABLE = (reason: string): SweepSupport => Object.freeze({ accepts: Object.freeze({}), reason });

/**
 * TOTAL over the fleet-eligible agents (spec § 5): flipping an agent to `eligible` fails typecheck
 * until it has an entry here, the same shape `FLEET_DIGEST_EXTRACTORS` uses. Every binding below was
 * verified against the agent's own parameter handling on 2026-09-17 (spec § 5.2/§ 5.3).
 */
export const FLEET_SWEEP_SUPPORT = Object.freeze({
  "agents.ownership": Object.freeze({
    accepts: Object.freeze({ paths: "path", services: "service" }),
    reason: null,
  }),
  "agents.oncall": Object.freeze({ accepts: Object.freeze({ services: "service" }), reason: null }),
  "agents.changelog": Object.freeze({ accepts: Object.freeze({ services: "service" }), reason: null }),
  // `file` resolves through `resolveMatchToken` — an exact symbol-LABEL match first, then a fuzzy
  // basename LIKE. A path sweep would hand every `index.ts` the same fuzzy token; the symbol's full
  // label takes the exact arm. Labels collide across kind/root (a stated bound, spec § 10).
  "agents.ghost": Object.freeze({ accepts: Object.freeze({ symbols: "file" }), reason: null }),
  "agents.conflicts": Object.freeze({ accepts: Object.freeze({ symbols: "file" }), reason: null }),
  "agents.glossary": Object.freeze({ accepts: Object.freeze({ terms: "term" }), reason: null }),
  "agents.why": NOT_SWEEPABLE("why answers a file LINE; a file-level sweep is not what it briefs"),
  "agents.expert": NOT_SWEEPABLE("expert's subject is a free-text topic; no corpus of topics exists"),
  "agents.impact": NOT_SWEEPABLE(
    "impact's service is a CONNECTOR id (e.g. github), not a configured service id",
  ),
  "agents.catchup": NOT_SWEEPABLE(
    "catchup's service filters by CONNECTOR id (e.g. github), not a configured service id",
  ),
  "agents.decisions": NOT_SWEEPABLE(
    "decisions matches --service by normalised repo / ticket-key NAME, not a configured service id",
  ),
  "agents.standup": NOT_SWEEPABLE("standup has no subject parameter"),
  "agents.huddle": NOT_SWEEPABLE("huddle has no subject parameter"),
  "agents.janitor": NOT_SWEEPABLE(
    "janitor's resourceRef is free text probed for mentions; the index holds no resource inventory, " +
      "so a list would be invented rather than enumerated",
  ),
}) satisfies Readonly<Record<EligibleAgentMethod, SweepSupport>>;

const SUPPORT_BY_METHOD: ReadonlyMap<string, SweepSupport> = new Map(
  Object.entries(FLEET_SWEEP_SUPPORT),
);

/** `null` when the agent is not fleet-eligible (the invoker refuses it separately). */
export function sweepSupportFor(agent: string): SweepSupport | null {
  const method = resolveFleetAgentMethod(agent);
  return method === null ? null : (SUPPORT_BY_METHOD.get(method) ?? null);
}

export function sweepParamFor(agent: string, kind: SweepKind): SweepSubjectParam | null {
  return sweepSupportFor(agent)?.accepts[kind] ?? null;
}

const FEDERATION_PARAMS: readonly string[] = ["namespace", "namespaces"];

/**
 * Spec § 4 rules 1, 2 and 6. Called by `assembleFleetRuntime` inside the SAME try that parses the
 * config, so a refusal disables the fleet with the loud log a parse error already gets.
 */
export function validateFleetSweepJobs(jobs: readonly NimbusFleetJobToml[]): void {
  for (const job of jobs) {
    if (job.sweep === null) continue;
    const { kind } = job.sweep;
    const param = sweepParamFor(job.agent, kind);
    if (param === null) {
      const reason = sweepSupportFor(job.agent)?.reason;
      throw new FleetConfigError(
        `[[fleet.job]] ${job.name} agent "${job.agent}" cannot sweep "${kind}"` +
          (reason === null || reason === undefined ? "" : `: ${reason}`),
      );
    }
    if (Object.hasOwn(job.params, param)) {
      throw new FleetConfigError(
        `[[fleet.job]] ${job.name} sets ${param} and sweep = "${kind}"; the sweep supplies ${param}`,
      );
    }
    if (FEDERATION_PARAMS.some((k) => Object.hasOwn(job.params, k))) {
      throw new FleetConfigError(
        `[[fleet.job]] ${job.name} combines sweep with namespace/namespaces; a sweep stays local ` +
          `(it would multiply federated calls under the owner's identity)`,
      );
    }
  }
}
```

If `satisfies` reports a missing or extra key, the eligible set has changed since this plan was written: classify the new agent against its real parameters (read `ipc/agents-rpc.ts` handler) and add an entry — do not delete a key to make it compile.

- [ ] **Step 4: Wire into assembly**

In `platform/assemble.ts`, import `import { validateFleetSweepJobs } from "../fleet/fleet-sweep-support.ts";` and inside `assembleFleetRuntime`'s `try` (line ~3049):

```ts
  try {
    const loaded = loadNimbusFleetFromPath(fleetToml);
    validateFleetSweepJobs(loaded.jobs);
    fleet = loaded;
  } catch (err) {
```

(Assign only after validation, so a refused config leaves `fleet` at its defaults exactly as a parse error does.)

- [ ] **Step 5: Settle the negotiate comment**

In `ipc/agents-rpc.ts`, replace the `agents.negotiate` comment in `FLEET_ELIGIBILITY` with:

```ts
  // No side effects and the shape fits — but `--person` makes it a dossier builder. SETTLED with
  // subject enumeration (PR 2b): a sweep would turn "the owner built one dossier" into "the machine
  // builds a dossier on every indexed person, nightly, unattended", which no current consent surface
  // covers. No sweep enumerator returns person-shaped subjects, and this stays deferred for that reason.
```

- [ ] **Step 6: Run and commit**

Run: `bun test packages/gateway/src/fleet packages/gateway/src/ipc/agents-rpc-fleet-eligibility.test.ts && bun run typecheck`
Also run the assembly test: `bun test packages/gateway/src/platform/assemble-fleet.test.ts` (locate with `rg -l assembleFleetRuntime packages/gateway --glob "*.test.ts"`).
Expected: PASS.
Commit: `feat(fleet): sweep support map and load-time sweep validation`

---

### Task 5: The four enumerators

**Files:**
- Create: `packages/gateway/src/fleet/fleet-sweep-enumerators.ts`
- Test: `packages/gateway/src/fleet/fleet-sweep-enumerators.test.ts`
- Modify: `packages/gateway/src/ownership/ownership-pass.ts:127` (`export function dirExternalId`)

**Interfaces:**
- Consumes: `SweepKind` (Task 3), `SweepSubjectParam` (Task 4), `codeUnitCompare`.
- Produces:
  - `export interface SweepSubject { readonly key: string; readonly params: Readonly<Record<string, string>> }`
  - `export interface SweepEnumeration { readonly subjects: readonly SweepSubject[]; readonly emptyReason: string | null }`
  - `export interface SweepEnumerateRequest { readonly kind: SweepKind; readonly param: SweepSubjectParam; readonly pathPrefix: string | null }`
  - `export type FleetSweepEnumerate = (req: SweepEnumerateRequest) => SweepEnumeration;`
  - `export interface SweepSources { readonly db: Database; readonly roots: () => readonly string[]; readonly serviceIds: () => readonly string[] }`
  - `export function buildFleetSweepEnumerate(src: SweepSources): FleetSweepEnumerate`
  - `enumeratePaths(db, roots, param, pathPrefix)`, `enumerateServices(serviceIds, param)`, `enumerateSymbols(db, param, pathPrefix)`, `enumerateTerms(db, param)` — all return `SweepEnumeration`, subjects sorted by `key` with `codeUnitCompare`.

- [ ] **Step 1: Export the directory id builder**

`ownership/ownership-pass.ts:127`: change `function dirExternalId(` to `export function dirExternalId(`.

- [ ] **Step 2: Write failing tests**

Create `packages/gateway/src/fleet/fleet-sweep-enumerators.test.ts`. Uses a fully migrated DB (`openMigratedDb`), production id builders, the production symbol writer (`syncGraphFromIndexedItem`), the production glossary writers, and — for every emitted subject — the AGENT'S OWN resolver:

```ts
import type { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveMatchToken } from "../agents/_lib/match-token.ts";
import { computeTermStats, markConsolidated, upsertCandidate } from "../glossary/glossary-store.ts";
import { normalizeTerm } from "../glossary/term-normalize.ts";
import { syncGraphFromIndexedItem } from "../graph/graph-populator.ts";
import { ensureGraphEntity } from "../graph/relationship-graph.ts";
import { openMigratedDb } from "../index/migrated-db-template.ts";
import { dirExternalId, fileExternalId } from "../ownership/ownership-pass.ts";
import { resolveOwnershipPath } from "../ownership/ownership-target.ts";
import { codeUnitCompare } from "../util/code-unit-compare.ts";
import {
  buildFleetSweepEnumerate,
  enumeratePaths,
  enumerateServices,
  enumerateSymbols,
  enumerateTerms,
} from "./fleet-sweep-enumerators.ts";

let dir: string;
let db: Database;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "nimbus-sweep-enum-"));
  db = openMigratedDb(join(dir, "nimbus.db"));
});

afterEach(() => {
  db.close(); // close BEFORE rm, or an EBUSY cleanup error replaces the real failure
  rmSync(dir, { recursive: true, force: true, maxRetries: 0 });
});

function repo(name: string, files: readonly string[]): string {
  const root = join(dir, name);
  for (const f of files) {
    mkdirSync(join(root, ...f.split("/").slice(0, -1)), { recursive: true });
    writeFileSync(join(root, ...f.split("/")), "x");
  }
  return root;
}

function fileNode(root: string, rel: string): void {
  ensureGraphEntity(db, { type: "source_file", externalId: fileExternalId(root, rel), label: rel, service: "filesystem" });
}
function dirNode(root: string, rel: string): void {
  ensureGraphEntity(db, { type: "directory", externalId: dirExternalId(root, rel), label: rel === "" ? root : rel, service: "filesystem" });
}

describe("enumeratePaths", () => {
  test("emits the ownership pass's own nodes, each resolving to ITS OWN root", () => {
    const a = repo("a", ["src/auth.ts"]);
    const b = repo("b", ["src/auth.ts"]);
    fileNode(a, "src/auth.ts");
    fileNode(b, "src/auth.ts");
    dirNode(a, "src");
    dirNode(a, "");

    const out = enumeratePaths(db, [a, b], "path", null);
    expect(out.emptyReason).toBeNull();
    expect(out.subjects.map((s) => s.key)).toEqual(
      [
        `paths:${dirExternalId(a, "")}`,
        `paths:${dirExternalId(a, "src")}`,
        `paths:${fileExternalId(a, "src/auth.ts")}`,
        `paths:${fileExternalId(b, "src/auth.ts")}`,
      ].sort(codeUnitCompare),
    );

    // The AGENT's resolver, not a key-shape check: the same relative path under two roots must
    // resolve to two different roots, and the root node must reach the root-itself arm.
    for (const s of out.subjects) {
      const path = s.params["path"];
      expect(path).toBeDefined();
      const resolved = resolveOwnershipPath([a, b], path ?? "");
      expect(resolved).not.toBeNull();
      const expectedRoot = s.key.includes(b) ? b : a;
      expect(resolved?.repoRoot).toBe(expectedRoot);
    }
    const rootSubject = out.subjects.find((s) => s.key === `paths:${dirExternalId(a, "")}`);
    expect(resolveOwnershipPath([a, b], rootSubject?.params["path"] ?? "")?.relPath).toBe("");
  });

  test("drops nodes under roots no longer configured", () => {
    const a = repo("a", ["x.ts"]);
    const gone = repo("gone", ["y.ts"]);
    fileNode(a, "x.ts");
    fileNode(gone, "y.ts");
    expect(enumeratePaths(db, [a], "path", null).subjects).toHaveLength(1);
  });

  test("path_prefix is a case-sensitive prefix on the relative path", () => {
    const a = repo("a", ["packages/x.ts", "Packages/y.ts", "src/z.ts"]);
    fileNode(a, "packages/x.ts");
    fileNode(a, "Packages/y.ts");
    fileNode(a, "src/z.ts");
    const out = enumeratePaths(db, [a], "path", "packages/");
    expect(out.subjects.map((s) => s.key)).toEqual([`paths:${fileExternalId(a, "packages/x.ts")}`]);
  });

  test("states WHY it is empty", () => {
    expect(enumeratePaths(db, [], "path", null).emptyReason).toMatch(/no git-aware filesystem roots/);
    const a = repo("a", []);
    expect(enumeratePaths(db, [a], "path", null).emptyReason).toMatch(/has not written any/);
    fileNode(a, "src/z.ts");
    expect(enumeratePaths(db, [a], "path", "docs/").emptyReason).toMatch(/under path_prefix "docs\/"/);
  });

  test("a key is identical across two enumerations of an unchanged index", () => {
    const a = repo("a", ["x.ts"]);
    fileNode(a, "x.ts");
    expect(enumeratePaths(db, [a], "path", null)).toEqual(enumeratePaths(db, [a], "path", null));
  });
});

describe("enumerateSymbols", () => {
  function symbol(id: string, name: string, file: string, kind: string): void {
    syncGraphFromIndexedItem(db, {
      id,
      service: "filesystem",
      type: "code_symbol",
      title: `${name} (${kind})`,
      bodyPreview: file,
      authorId: null,
      metadata: { name, kind, file, repoRoot: "/r" },
    });
  }

  test("emits each DISTINCT label; the agent's exact-label lookup resolves it", () => {
    symbol("filesystem:sym:1", "parseConfig", "src/config.ts", "function");
    symbol("filesystem:sym:2", "Widget", "src/ui/widget.ts", "class");
    const out = enumerateSymbols(db, "file", null);
    expect(out.emptyReason).toBeNull();
    for (const s of out.subjects) {
      const token = resolveMatchToken(db, s.params["file"] ?? "");
      expect(token.entityId).not.toBeNull();
      expect(token.token).toBe(s.params["file"] ?? "");
    }
  });

  test("a label collision (same name + file, different kind) is ONE subject — stated bound", () => {
    symbol("filesystem:sym:1", "Config", "src/config.ts", "function");
    symbol("filesystem:sym:2", "Config", "src/config.ts", "type");
    expect(enumerateSymbols(db, "file", null).subjects).toHaveLength(1);
  });

  test("path_prefix matches the label's file part", () => {
    symbol("filesystem:sym:1", "a", "src/ui/a.ts", "function");
    symbol("filesystem:sym:2", "b", "lib/b.ts", "function");
    const out = enumerateSymbols(db, "file", "src/");
    expect(out.subjects.map((s) => s.params["file"])).toEqual(["a — src/ui/a.ts"]);
  });

  test("states why it is empty", () => {
    expect(enumerateSymbols(db, "file", null).emptyReason).toMatch(/no code symbols are indexed/);
  });
});

describe("enumerateTerms", () => {
  test("consolidated terms only; the parameter normalises back to the key", () => {
    for (const [surface, consolidate] of [["Retry Budget", true], ["Pending Thing", false]] as const) {
      const key = normalizeTerm(surface);
      upsertCandidate(db, {
        key,
        surface,
        form: "phrase",
        stats: computeTermStats(db, key),
        score: 1,
        nowMs: 1,
      });
      if (consolidate) {
        markConsolidated(db, {
          termKey: key,
          definition: "d",
          definitionSource: "snippet",
          synonyms: [],
          nearMisses: [],
          nowMs: 2,
        });
      }
    }
    const out = enumerateTerms(db, "term");
    expect(out.subjects).toHaveLength(1);
    const [s] = out.subjects;
    expect(s?.key).toBe(`terms:${normalizeTerm("Retry Budget")}`);
    expect(normalizeTerm(s?.params["term"] ?? "")).toBe(normalizeTerm("Retry Budget"));
  });

  test("states why it is empty", () => {
    expect(enumerateTerms(db, "term").emptyReason).toMatch(/no consolidated glossary terms/);
  });
});

describe("enumerateServices", () => {
  test("one subject per configured service id, sorted", () => {
    const out = enumerateServices(["checkout", "billing"], "service");
    expect(out.subjects).toEqual([
      { key: "services:billing", params: { service: "billing" } },
      { key: "services:checkout", params: { service: "checkout" } },
    ]);
  });

  test("states why it is empty", () => {
    expect(enumerateServices([], "service").emptyReason).toMatch(/no services are configured/);
  });
});

describe("buildFleetSweepEnumerate", () => {
  test("reads roots and services FRESH on every call", () => {
    let ids: string[] = ["a"];
    const enumerate = buildFleetSweepEnumerate({ db, roots: () => [], serviceIds: () => ids });
    expect(enumerate({ kind: "services", param: "service", pathPrefix: null }).subjects).toHaveLength(1);
    ids = ["a", "b"];
    expect(enumerate({ kind: "services", param: "service", pathPrefix: null }).subjects).toHaveLength(2);
  });
});
```

If `upsertCandidate`'s `stats` or `form` types differ from the above, read `glossary/glossary-store.ts:164` and `glossary/glossary-types.ts` and adapt the literal — do NOT replace the production writer with a raw INSERT.

- [ ] **Step 3: Run to verify failure**

Run: `bun test packages/gateway/src/fleet/fleet-sweep-enumerators.test.ts`
Expected: FAIL (module not found).

- [ ] **Step 4: Implement**

Create `packages/gateway/src/fleet/fleet-sweep-enumerators.ts`:

```ts
import type { Database } from "bun:sqlite";
import { join } from "node:path";
import type { SweepKind } from "../config/fleet-toml.ts";
import { codeUnitCompare } from "../util/code-unit-compare.ts";
import type { SweepSubjectParam } from "./fleet-sweep-support.ts";

export interface SweepSubject {
  readonly key: string;
  readonly params: Readonly<Record<string, string>>;
}

export interface SweepEnumeration {
  readonly subjects: readonly SweepSubject[];
  /** Why the list is empty; null whenever it is not. Surfaced by `fleet.list`. */
  readonly emptyReason: string | null;
}

export interface SweepEnumerateRequest {
  readonly kind: SweepKind;
  readonly param: SweepSubjectParam;
  readonly pathPrefix: string | null;
}

export type FleetSweepEnumerate = (req: SweepEnumerateRequest) => SweepEnumeration;

export interface SweepSources {
  readonly db: Database;
  /** Called per enumeration, so a root added since boot is swept on the next run. */
  readonly roots: () => readonly string[];
  readonly serviceIds: () => readonly string[];
}

function finish(subjects: SweepSubject[], reasonIfEmpty: string): SweepEnumeration {
  subjects.sort((a, b) => codeUnitCompare(a.key, b.key));
  return { subjects, emptyReason: subjects.length === 0 ? reasonIfEmpty : null };
}

/** `file:<root>:<rel>` / `dir:<root>:<rel>` → root + rel, matched against CONFIGURED roots only. */
function matchOwnershipNode(
  type: string,
  externalId: string,
  rootsLongestFirst: readonly string[],
): { root: string; rel: string } | null {
  const tag = type === "source_file" ? "file" : "dir";
  for (const root of rootsLongestFirst) {
    const prefix = `${tag}:${root}:`;
    if (externalId.startsWith(prefix)) return { root, rel: externalId.slice(prefix.length) };
  }
  return null;
}

/**
 * The ownership pass's OWN `source_file`/`directory` nodes (spec § 5.2) — exactly what the agent can
 * answer, distinct by construction. The key reuses the node's external id VERBATIM: normalising it
 * (e.g. lower-casing a drive letter) would make a key disagree with the node it names. The param is
 * the ABSOLUTE path, so `resolveOwnershipPath` resolves against exactly one root.
 */
export function enumeratePaths(
  db: Database,
  roots: readonly string[],
  param: SweepSubjectParam,
  pathPrefix: string | null,
): SweepEnumeration {
  if (roots.length === 0) {
    return {
      subjects: [],
      emptyReason: "no git-aware filesystem roots are configured, so the ownership pass has no nodes to sweep",
    };
  }
  const rows = db
    .query(`SELECT type, external_id FROM graph_entity WHERE type IN ('source_file', 'directory')`)
    .all() as ReadonlyArray<{ type: string; external_id: string }>;
  const longestFirst = [...roots].sort((a, b) => b.length - a.length);
  const subjects: SweepSubject[] = [];
  for (const r of rows) {
    const hit = matchOwnershipNode(r.type, r.external_id, longestFirst);
    if (hit === null) continue;
    if (pathPrefix !== null && !hit.rel.startsWith(pathPrefix)) continue;
    subjects.push({
      key: `paths:${r.external_id}`,
      params: { [param]: hit.rel === "" ? hit.root : join(hit.root, hit.rel) },
    });
  }
  let reason = "no ownership node lies under a configured git-aware root";
  if (rows.length === 0) reason = "the ownership pass has not written any file or directory nodes yet";
  else if (pathPrefix !== null) reason = `no ownership node lies under path_prefix "${pathPrefix}"`;
  return finish(subjects, reason);
}

/** `loadNimbusServiceConfigsFromConfigDir` keys — the loader agents resolve `service` against. */
export function enumerateServices(
  serviceIds: readonly string[],
  param: SweepSubjectParam,
): SweepEnumeration {
  return finish(
    serviceIds.map((id) => ({ key: `services:${id}`, params: { [param]: id } })),
    "no services are configured ([ci.service.<id>] or [metrics.dora.<id>])",
  );
}

/** `syncCodeSymbolGraph` writes symbol labels as `<name> — <file>`. */
const SYMBOL_LABEL_SEPARATOR = " — ";

/**
 * DISTINCT symbol labels. A label collision (same name + file across kind or root) is ONE subject —
 * the stated bound in spec § 10; the agent's exact-label lookup briefs one of the colliding entities.
 */
export function enumerateSymbols(
  db: Database,
  param: SweepSubjectParam,
  pathPrefix: string | null,
): SweepEnumeration {
  const rows = db
    .query(`SELECT DISTINCT label FROM graph_entity WHERE type = 'symbol'`)
    .all() as ReadonlyArray<{ label: string }>;
  const subjects: SweepSubject[] = [];
  for (const { label } of rows) {
    if (pathPrefix !== null) {
      const at = label.lastIndexOf(SYMBOL_LABEL_SEPARATOR);
      // A label with no separator has no file part to match. `syncCodeSymbolGraph` is the ONLY
      // writer of `symbol` entities and always writes the separator, so this arm is not reachable
      // from production data; if it ever is, EXCLUDING the symbol from a path-filtered sweep is the
      // honest answer. Falling back to the whole label would match the symbol NAME against a path
      // prefix and admit a symbol whose file is unknown.
      const file = at === -1 ? "" : label.slice(at + SYMBOL_LABEL_SEPARATOR.length);
      if (!file.startsWith(pathPrefix)) continue;
    }
    subjects.push({ key: `symbols:${label}`, params: { [param]: label } });
  }
  return finish(
    subjects,
    rows.length === 0
      ? "no code symbols are indexed (enable code_index on a [[filesystem.roots]] entry)"
      : `no code symbol's file lies under path_prefix "${pathPrefix ?? ""}"`,
  );
}

/** Consolidated terms only; the param is `display_term`, which the agent normalises to `term_key`. */
export function enumerateTerms(db: Database, param: SweepSubjectParam): SweepEnumeration {
  const rows = db
    .query(`SELECT term_key, display_term FROM glossary_term WHERE status = 'consolidated'`)
    .all() as ReadonlyArray<{ term_key: string; display_term: string }>;
  return finish(
    rows.map((r) => ({ key: `terms:${r.term_key}`, params: { [param]: r.display_term } })),
    "no consolidated glossary terms yet",
  );
}

export function buildFleetSweepEnumerate(src: SweepSources): FleetSweepEnumerate {
  return (req) => {
    switch (req.kind) {
      case "paths":
        return enumeratePaths(src.db, src.roots(), req.param, req.pathPrefix);
      case "services":
        return enumerateServices(src.serviceIds(), req.param);
      case "symbols":
        return enumerateSymbols(src.db, req.param, req.pathPrefix);
      case "terms":
        return enumerateTerms(src.db, req.param);
      default: {
        const unreachable: never = req.kind;
        throw new Error(`unknown sweep kind: ${String(unreachable)}`);
      }
    }
  };
}
```

- [ ] **Step 5: Run and commit**

Run: `bun test packages/gateway/src/fleet/fleet-sweep-enumerators.test.ts && bun run typecheck`
Expected: PASS. If `resolveMatchToken(...).token` differs from the label because the exact-match branch returns something else, STOP and report — that invalidates spec D5 and needs a decision, not a test edit.
Commit: `feat(fleet): paths, services, symbols and terms sweep enumerators`

---

### Task 6: Scheduler — `runSweepJob`, the cursor window, subject counters, wiring

**Files:**
- Create: `packages/gateway/src/fleet/fleet-sweep-window.ts`
- Test: `packages/gateway/src/fleet/fleet-sweep-window.test.ts`
- Modify: `packages/gateway/src/fleet/fleet-scheduler.ts`
- Test: `packages/gateway/src/fleet/fleet-scheduler.test.ts`
- Modify: `packages/gateway/src/platform/assemble.ts` (scheduler construction ~line 3095)

**Interfaces:**
- Consumes: `FleetSweepEnumerate`, `SweepSubject` (Task 5); `sweepParamFor` (Task 4); store sweep methods + `closeRun` subject fields (Task 2); `FleetJobSweepToml` (Task 3).
- Produces:
  - `export function selectSweepWindow(keys: readonly string[], cursor: string | null, max: number): string[]`
  - `FleetSchedulerDeps.enumerate: FleetSweepEnumerate` (REQUIRED)
  - `FleetRunSummary` gains `subjectsInScope`, `subjectsAttempted`, `subjectsCompleted: number`.

- [ ] **Step 1: Failing window tests**

Create `packages/gateway/src/fleet/fleet-sweep-window.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { selectSweepWindow } from "./fleet-sweep-window.ts";

describe("selectSweepWindow", () => {
  const keys = ["a", "b", "c", "d", "e"];

  test("a null cursor starts at the first key", () => {
    expect(selectSweepWindow(keys, null, 2)).toEqual(["a", "b"]);
  });

  test("starts strictly after the cursor and wraps", () => {
    expect(selectSweepWindow(keys, "d", 3)).toEqual(["e", "a", "b"]);
  });

  test("a cursor past the last key wraps to the start", () => {
    expect(selectSweepWindow(keys, "z", 2)).toEqual(["a", "b"]);
  });

  test("a DELETED cursor key neither skips nor repeats — next greater key", () => {
    expect(selectSweepWindow(["a", "b", "d", "e"], "c", 2)).toEqual(["d", "e"]);
  });

  test("an ADDED key after the cursor is picked up in order", () => {
    expect(selectSweepWindow(["a", "b", "bb", "c"], "b", 2)).toEqual(["bb", "c"]);
  });

  test("a list no longer than max is taken whole, once — never padded by wrapping", () => {
    expect(selectSweepWindow(["a", "b"], "a", 5)).toEqual(["a", "b"]);
  });

  test("sorts its input by code unit rather than trusting caller order", () => {
    expect(selectSweepWindow(["c", "a", "b"], null, 2)).toEqual(["a", "b"]);
  });

  test("empty in, empty out", () => {
    expect(selectSweepWindow([], "a", 3)).toEqual([]);
  });
});
```

- [ ] **Step 2: Run → FAIL; implement; run → PASS**

Create `packages/gateway/src/fleet/fleet-sweep-window.ts`:

```ts
import { codeUnitCompare } from "../util/code-unit-compare.ts";

/**
 * The next window of a rotation: up to `max` distinct keys starting at the first key STRICTLY
 * greater than `cursor`, wrapping to the start. A key cursor, not an ordinal — an ordinal shifts when
 * a subject is added or deleted and would silently skip or repeat one (spec § 6). A list no longer
 * than `max` is returned whole, once.
 */
export function selectSweepWindow(keys: readonly string[], cursor: string | null, max: number): string[] {
  const sorted = [...keys].sort(codeUnitCompare);
  if (sorted.length <= max) return sorted;
  let start = 0;
  if (cursor !== null) {
    const next = sorted.findIndex((k) => codeUnitCompare(k, cursor) > 0);
    start = next === -1 ? 0 : next;
  }
  const out: string[] = [];
  for (let i = 0; i < max; i += 1) {
    const k = sorted[(start + i) % sorted.length];
    if (k !== undefined) out.push(k);
  }
  return out;
}
```

Run: `bun test packages/gateway/src/fleet/fleet-sweep-window.test.ts` → PASS.

- [ ] **Step 3: Failing scheduler tests**

In `fleet/fleet-scheduler.test.ts`, extend `build(opts)` with `enumerate?: FleetSweepEnumerate` and pass `enumerate: opts.enumerate ?? (() => { throw new Error("test bug: no enumerator configured"); })` into the scheduler deps. Add imports for `FleetSweepEnumerate`/`SweepSubject` from `./fleet-sweep-enumerators.ts`. Add:

```ts
describe("sweep jobs", () => {
  const SWEEP: NimbusFleetJobToml = {
    name: "bus",
    agent: "ownership",
    intervalSeconds: 1,
    params: {},
    digestMinDelta: 1,
    sweep: { kind: "paths", maxSubjects: 2, pathPrefix: null },
  };
  const AC_IDLE: HostActivityProbe = { power: "ac", idleMs: 3_600_000, source: "measured" };
  const BATTERY: HostActivityProbe = { power: "battery", idleMs: 3_600_000, source: "measured" };

  function subjects(...keys: string[]): SweepSubject[] {
    return keys.map((k) => ({ key: `paths:${k}`, params: { path: `/r/${k}` } }));
  }

  function briefKeys(): string[] {
    return (db.query("SELECT subject_key FROM fleet_brief ORDER BY subject_key").all() as Array<{
      subject_key: string;
    }>).map((r) => r.subject_key);
  }

  test("runs the next window, merges the subject param, records subject keys, advances the cursor", async () => {
    const seen: unknown[] = [];
    const s = build({
      probes: [AC_IDLE],
      jobs: [SWEEP],
      enumerate: () => ({ subjects: subjects("a", "b", "c"), emptyReason: null }),
      invoke: async (job) => {
        seen.push(job.params);
        return done(job.name);
      },
    });
    const summary = await s.runOnce();
    expect(seen).toEqual([{ path: "/r/a" }, { path: "/r/b" }]);
    expect(briefKeys()).toEqual(["paths:a", "paths:b"]);
    expect(store.loadSweepState("bus")).toMatchObject({ cursor: "paths:b", subjectsTotal: 3 });
    expect(summary).toMatchObject({ subjectsInScope: 2, subjectsAttempted: 2, subjectsCompleted: 2 });
  });

  test("(red-prove) admission is re-probed between SUBJECTS; a yield resumes from the cursor", async () => {
    let probes = 0;
    const s = build({
      probes: [AC_IDLE, AC_IDLE, BATTERY],
      jobs: [{ ...SWEEP, sweep: { kind: "paths", maxSubjects: 3, pathPrefix: null } }],
      enumerate: () => ({ subjects: subjects("a", "b", "c"), emptyReason: null }),
      invoke: async (job) => done(job.name),
      onProbe: () => {
        probes += 1;
      },
    });
    const first = await s.runOnce();
    expect(first.outcome).toBe("yielded");
    expect(briefKeys()).toEqual(["paths:a", "paths:b"]);
    expect(store.loadJobState("bus")?.lastSuccessAt ?? null).toBeNull(); // still due
    expect(probes).toBe(3);

    const resumed = build({
      probes: [AC_IDLE],
      jobs: [{ ...SWEEP, sweep: { kind: "paths", maxSubjects: 1, pathPrefix: null } }],
      enumerate: () => ({ subjects: subjects("a", "b", "c"), emptyReason: null }),
      invoke: async (job) => done(job.name),
    });
    await resumed.runOnce();
    expect(briefKeys()).toEqual(["paths:a", "paths:b", "paths:c"]);
  });

  test("a failed subject advances the cursor and does not back off the job", async () => {
    const s = build({
      probes: [AC_IDLE],
      jobs: [SWEEP],
      enumerate: () => ({ subjects: subjects("a", "b"), emptyReason: null }),
      invoke: async (job) =>
        job.params["path"] === "/r/a" ? { status: "failed", error: "boom" } : done(job.name),
    });
    const summary = await s.runOnce();
    expect(store.loadSweepState("bus")?.cursor).toBe("paths:b");
    expect(store.loadJobState("bus")?.backoffUntil ?? null).toBeNull();
    expect(summary).toMatchObject({ subjectsAttempted: 2, subjectsCompleted: 1, jobsCompleted: 1 });
  });

  test("every subject failing backs the job off", async () => {
    const s = build({
      probes: [AC_IDLE],
      jobs: [SWEEP],
      enumerate: () => ({ subjects: subjects("a", "b"), emptyReason: null }),
      invoke: async () => ({ status: "failed", error: "boom" }),
    });
    await s.runOnce();
    expect(store.loadJobState("bus")?.consecutiveFailures).toBe(1);
    expect(store.loadJobState("bus")?.lastError).toMatch(/all 2 sweep subjects failed/);
  });

  test("an enumeration that throws backs the job off", async () => {
    const s = build({
      probes: [AC_IDLE],
      jobs: [SWEEP],
      enumerate: () => {
        throw new Error("bad config");
      },
      invoke: async (job) => done(job.name),
    });
    await s.runOnce();
    expect(store.loadJobState("bus")?.lastError).toMatch(/sweep enumeration failed: bad config/);
  });

  test("an EMPTY enumeration is success with its reason recorded, not a failure", async () => {
    const s = build({
      probes: [AC_IDLE],
      jobs: [SWEEP],
      enumerate: () => ({ subjects: [], emptyReason: "no git-aware filesystem roots are configured" }),
      invoke: async (job) => done(job.name),
    });
    await s.runOnce();
    expect(store.loadJobState("bus")?.lastSuccessAt).toBe(NOW);
    expect(store.loadSweepState("bus")).toMatchObject({ subjectsTotal: 0, emptyReason: "no git-aware filesystem roots are configured" });
  });

  test("the I38 budget is reset ONCE per run, not per subject", async () => {
    let resets = 0;
    const budget: FleetRunBudget = {
      reset: () => {
        resets += 1;
      },
      spent: () => 0,
      remaining: () => 0,
    };
    const s = build({
      probes: [AC_IDLE],
      jobs: [{ ...SWEEP, sweep: { kind: "paths", maxSubjects: 3, pathPrefix: null } }],
      enumerate: () => ({ subjects: subjects("a", "b", "c"), emptyReason: null }),
      invoke: async (job) => done(job.name),
      remoteBudget: budget,
    });
    await s.runOnce();
    expect(resets).toBe(1);
  });

  test("a config-named job counts as ONE subject on the run row", async () => {
    const [first] = JOBS;
    if (first === undefined) throw new Error("test bug: JOBS is empty");
    const s = build({ probes: [AC_IDLE], jobs: [first], invoke: async (j) => done(j.name) });
    const summary = await s.runOnce();
    const row = db
      .query("SELECT subjects_in_scope, subjects_attempted, subjects_completed FROM fleet_run WHERE id = ?")
      .get(requireRunId(summary)) as Record<string, number>;
    expect(row).toEqual({ subjects_in_scope: 1, subjects_attempted: 1, subjects_completed: 1 });
  });
});
```

`AC_IDLE` is admitted and `BATTERY` refused under `DEFAULT_FLEET_CONFIG` (`require_ac_power = true`, `min_idle_seconds = 900`) per `admitFleetRun`; if the file already defines equivalent probe constants, reuse those instead of adding duplicates. Existing `FleetRunSummary` `toEqual` assertions in the file gain the three subject fields.

- [ ] **Step 4: Run → FAIL**

Run: `bun test packages/gateway/src/fleet/fleet-scheduler.test.ts -t "sweep jobs"`
Expected: FAIL.

- [ ] **Step 5: Implement in the scheduler**

In `packages/gateway/src/fleet/fleet-scheduler.ts`:

Imports:

```ts
import type { FleetJobSweepToml } from "../config/fleet-toml.ts";
import type { FleetSweepEnumerate, SweepSubject } from "./fleet-sweep-enumerators.ts";
import { sweepParamFor } from "./fleet-sweep-support.ts";
import { selectSweepWindow } from "./fleet-sweep-window.ts";
```

`FleetRunSummary` gains, after `jobsSkippedNotDue`:

```ts
  /** Units of brief production selected this run: 1 per due config-named job, the window per sweep. */
  readonly subjectsInScope: number;
  readonly subjectsAttempted: number;
  readonly subjectsCompleted: number;
```

The in-flight early return in `runOnce` adds `subjectsInScope: 0, subjectsAttempted: 0, subjectsCompleted: 0`.

`FleetSchedulerDeps` gains:

```ts
  /**
   * Enumerates a sweep job's subjects (spec § 5). REQUIRED: a scheduler that could not enumerate would
   * silently run no sweep at all, the optional-dep shape PR 1 already paid for once.
   */
  readonly enumerate: FleetSweepEnumerate;
```

Add a tally type near the top of the class section:

```ts
/** ONE mutable record every exit reads — see `execute`'s `close`. */
interface RunTally {
  attempted: number;
  completed: number;
  skippedNotDue: number;
  subjectsInScope: number;
  subjectsAttempted: number;
  subjectsCompleted: number;
}

type SweepJobResult = "succeeded" | "failed" | "yielded";
```

Methods (add to the class):

```ts
  /**
   * Enumerate, persist what was found, and select this run's window. `null` means enumeration
   * failed and the failure is already recorded (backoff).
   */
  private enumerateWindow(job: NimbusFleetJobToml, sweep: FleetJobSweepToml): SweepSubject[] | null {
    const param = sweepParamFor(job.agent, sweep.kind);
    if (param === null) {
      // Unreachable after `validateFleetSweepJobs`; recorded rather than thrown so a config that
      // bypassed validation fails one job, not the run.
      this.deps.store.recordJobFailure(job.name, this.deps.now(), `agent ${job.agent} cannot sweep ${sweep.kind}`);
      return null;
    }
    let found: ReturnType<FleetSweepEnumerate>;
    try {
      found = this.deps.enumerate({ kind: sweep.kind, param, pathPrefix: sweep.pathPrefix });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      this.deps.store.recordJobFailure(job.name, this.deps.now(), `sweep enumeration failed: ${msg}`);
      return null;
    }
    this.deps.store.recordSweepEnumeration(job.name, {
      kind: sweep.kind,
      subjectsTotal: found.subjects.length,
      emptyReason: found.emptyReason,
    });
    const cursor = this.deps.store.loadSweepState(job.name)?.cursor ?? null;
    const byKey = new Map(found.subjects.map((s) => [s.key, s]));
    return selectSweepWindow([...byKey.keys()], cursor, sweep.maxSubjects).flatMap((k) => {
      const s = byKey.get(k);
      return s === undefined ? [] : [s];
    });
  }

  /** One subject's turn. Unlike `runOneJob`, a failure is NOT a job failure — the window decides that. */
  private async runSweepSubject(
    job: NimbusFleetJobToml,
    subject: SweepSubject,
    runId: string,
    expiresAt: number,
  ): Promise<string | null> {
    const outcome = await this.deps.invoke({ ...job, params: { ...job.params, ...subject.params } });
    if (outcome.status !== "done") return outcome.error;
    this.deps.store.recordBrief({
      runId,
      jobId: job.name,
      subjectKey: subject.key,
      agentMethod: `agents.${job.agent}`,
      briefMarkdown: outcome.briefMarkdown,
      findingsJson: outcome.findingsJson,
      synthesisJson: outcome.synthesisJson,
      createdAt: this.deps.now(),
      expiresAt,
    });
    return null;
  }

  /**
   * A sweep job's turn (spec § 7). The cursor advances after EVERY subject, success or failure, so
   * one broken subject cannot pin the rotation. A yield records no success, so the job stays due and
   * resumes from the cursor. The first subject is not re-probed: `execute` probed at the job boundary.
   */
  private async runSweepJob(
    job: NimbusFleetJobToml,
    sweep: FleetJobSweepToml,
    runId: string,
    expiresAt: number,
    tally: RunTally,
    force: boolean,
  ): Promise<SweepJobResult> {
    const window = this.enumerateWindow(job, sweep);
    if (window === null) return "failed";
    if (window.length === 0) {
      this.deps.store.recordJobSuccess(job.name, this.deps.now());
      return "succeeded";
    }
    tally.subjectsInScope += window.length;
    let succeeded = 0;
    let firstError: string | null = null;
    for (const [i, subject] of window.entries()) {
      if (i > 0 && !(await this.stillAdmitted(tally.subjectsAttempted, force))) return "yielded";
      tally.subjectsAttempted += 1;
      const error = await this.runSweepSubject(job, subject, runId, expiresAt);
      if (error === null) {
        succeeded += 1;
        tally.subjectsCompleted += 1;
      } else {
        firstError ??= error;
      }
      this.deps.store.advanceSweepCursor(job.name, sweep.kind, subject.key);
    }
    if (succeeded > 0) {
      this.deps.store.recordJobSuccess(job.name, this.deps.now());
      return "succeeded";
    }
    this.deps.store.recordJobFailure(
      job.name,
      this.deps.now(),
      `all ${String(window.length)} sweep subjects failed; first: ${firstError ?? "unknown"}`,
    );
    return "failed";
  }
```

In `execute`: replace `const tally = { attempted: 0, completed: 0, skippedNotDue: 0 };` with
`const tally: RunTally = { attempted: 0, completed: 0, skippedNotDue: 0, subjectsInScope: 0, subjectsAttempted: 0, subjectsCompleted: 0 };`.
In `close`, pass `subjectsInScope: tally.subjectsInScope, subjectsAttempted: tally.subjectsAttempted, subjectsCompleted: tally.subjectsCompleted` to `closeRun` (replacing Task 2's zeros) and add the same three fields to the returned summary.
Replace the job loop body with:

```ts
      for (const job of jobs) {
        // Keyed on SUBJECTS attempted: one counter across both job kinds, so admission is re-checked
        // at every unit boundary (a config-named job is one unit).
        if (!(await this.stillAdmitted(tally.subjectsAttempted, force))) return close("yielded");

        if (!namedJob && !isJobDue(job, this.deps.store.loadJobState(job.name), this.deps.now())) {
          tally.skippedNotDue += 1;
          continue;
        }

        tally.attempted += 1;
        if (job.sweep === null) {
          tally.subjectsInScope += 1;
          tally.subjectsAttempted += 1;
          if (await this.runOneJob(job, runId, expiresAt)) {
            tally.completed += 1;
            tally.subjectsCompleted += 1;
          }
          continue;
        }
        const result = await this.runSweepJob(job, job.sweep, runId, expiresAt, tally, force);
        if (result === "yielded") return close("yielded");
        if (result === "succeeded") tally.completed += 1;
      }
```

Keep every existing comment in the loop (the due-check comment block) above the lines it describes.

- [ ] **Step 6: Wire the enumerator in assembly**

In `platform/assemble.ts`, import `buildFleetSweepEnumerate` from `../fleet/fleet-sweep-enumerators.ts` and `ownershipRoots` from `../ownership/ownership-target.ts` (if not already imported). In the `new FleetScheduler({ … })` call add:

```ts
    // Roots and services are read FRESH per enumeration. Services use the loader agents resolve
    // `service` against — deliberately NOT `loadServiceConfigsOrDegrade`: degrading to an empty map
    // would report "no services are configured" for a config that is merely malformed, where a throw
    // records the real cause on the job and backs it off.
    enumerate: buildFleetSweepEnumerate({
      db: deps.db,
      roots: () => ownershipRoots(deps.paths.configDir),
      serviceIds: () => [...loadNimbusServiceConfigsFromConfigDir(deps.paths.configDir).keys()],
    }),
```

- [ ] **Step 7: Run; red-prove; commit**

Run: `bun test packages/gateway/src/fleet packages/gateway/src/ipc/fleet-rpc.test.ts && bun test $(rg -l assembleFleetRuntime packages/gateway --glob "*.test.ts") && bun run typecheck`
Expected: PASS.
**Red-prove** the admission test: change `if (i > 0 && !(await this.stillAdmitted(` to `if (false && !(await this.stillAdmitted(`; confirm "re-probed between SUBJECTS" FAILS; restore.
Commit: `feat(fleet): run sweep jobs through a key-cursor rotation`

---

### Task 7: Digest — sweep grouping and rendering

**Files:**
- Modify: `packages/gateway/src/fleet/fleet-digest-types.ts`
- Modify: `packages/gateway/src/fleet/fleet-digest.ts`
- Modify: `packages/gateway/src/ipc/fleet-rpc.ts:231` (`retentionDays`)
- Test: `packages/gateway/src/fleet/fleet-digest.test.ts`

**Interfaces:**
- Consumes: `briefPairForSubject`, `subjectKeysWithBriefsInWindow`, `loadSweepState` (Task 2); `SweepKind`, `SWEEP_KINDS` (Task 3).
- Produces (in `fleet-digest-types.ts`): `FleetSweepSubjectDigest`, `FleetDigestSubjectRef`, `FleetSweepDigest` exactly as spec § 8.1; `FleetDigestResult.sweeps: readonly FleetSweepDigest[]`; `buildFleetDigest` deps gain REQUIRED `retentionDays: number`.

- [ ] **Step 1: Add the types**

Append to `fleet/fleet-digest-types.ts` (add `import type { SweepKind } from "../config/fleet-toml.ts";`):

```ts
export type FleetSweepSubjectDigest = FleetJobDigest & { readonly subjectKey: string };

export interface FleetDigestSubjectRef {
  readonly subjectKey: string;
  readonly briefId: string;
  readonly reason: string;
}

export interface FleetSweepDigest {
  readonly jobId: string;
  readonly agentMethod: string;
  /** From config; for an unconfigured sweep, the key prefix — null only if that prefix is not a kind. */
  readonly sweepKind: SweepKind | null;
  readonly configured: boolean;
  /** At the last enumeration; null when the job has never enumerated. */
  readonly subjectsTotal: number | null;
  readonly subjectsSweptInWindow: number;
  /** ceil(total / max_subjects); null when either is unknown. */
  readonly rotationRunsEstimate: number | null;
  /** rotationRunsEstimate × interval; null under the same condition. */
  readonly rotationMsEstimate: number | null;
  readonly retentionMs: number;
  readonly rotationExceedsRetention: boolean;
  readonly moved: readonly FleetSweepSubjectDigest[];
  readonly unchangedCount: number;
  /** Unchanged ONLY because digest_min_delta withheld a metric (2a § 6.3). */
  readonly unchangedWithinThresholdCount: number;
  /** Every key, code-unit sorted; Markdown truncates, JSON does not. */
  readonly firstObservationKeys: readonly string[];
  readonly notSummarizable: readonly FleetDigestSubjectRef[];
  readonly agentChanged: readonly FleetDigestSubjectRef[];
  /** Job-level: no subject of this job has a brief in the window. */
  readonly noBriefInWindow: boolean;
}
```

and add `readonly sweeps: readonly FleetSweepDigest[];` to `FleetDigestResult` after `notCompared`.

- [ ] **Step 2: Update existing digest test call sites**

Run `bun run typecheck`. Add `retentionDays: 14` to every `buildFleetDigest({…})` call (11 in `fleet-digest.test.ts`), and `sweeps: []` to every object literal passed to `renderFleetDigest(…)` (21 sites). Do NOT change any expected Markdown string — those are the byte-identity guard for config-named jobs.

- [ ] **Step 3: Write failing sweep digest tests**

Add INSIDE the existing digest `describe` in `fleet/fleet-digest.test.ts` that defines `job()`, `ghostFindings()` and `insertBrief()` (~lines 137–205), so those helpers are in scope. `agents.ghost` is sweepable (`symbols`), and `ghostFindings(peerIds)` is the file's existing fixture: different peer lists summarise differently (moved), identical ones do not (unchanged).

```ts
  describe("sweep jobs", () => {
    const SWEEP_JOB: NimbusFleetJobToml = {
      name: "sym",
      agent: "ghost",
      intervalSeconds: 86_400,
      params: {},
      digestMinDelta: 1,
      sweep: { kind: "symbols", maxSubjects: 2, pathPrefix: null },
    };
    const brief = (subjectKey: string, createdAt: number, peers: string[]): void =>
      insertBrief({
        jobId: "sym",
        subjectKey,
        agentMethod: "agents.ghost",
        createdAt,
        findings: ghostFindings(peers),
      });

    test("groups a sweep job into ONE sweeps entry with per-subject outcomes", () => {
      brief("symbols:a", 100, ["p1"]);
      brief("symbols:a", 5000, ["p1", "p2"]); // moved
      brief("symbols:b", 100, ["p1"]);
      brief("symbols:b", 5000, ["p1"]); // unchanged
      for (const k of ["c", "d", "e", "f", "g", "h", "i", "j", "k", "l", "m", "n"]) {
        brief(`symbols:${k}`, 5000, ["p1"]); // first observation
      }
      store.recordSweepEnumeration("sym", { kind: "symbols", subjectsTotal: 40, emptyReason: null });

      const r = buildFleetDigest({ store, jobs: [SWEEP_JOB], windowMs: 1000, now: 5500, retentionDays: 14 });
      expect(r.jobs).toEqual([]);
      expect(r.notCompared.firstObservation).toEqual([]);
      expect(r.sweeps).toHaveLength(1);
      const s = r.sweeps[0];
      expect(s?.moved.map((m) => m.subjectKey)).toEqual(["symbols:a"]);
      expect(s?.unchangedCount).toBe(1);
      expect(s?.firstObservationKeys).toHaveLength(12);
      expect(s?.subjectsSweptInWindow).toBe(14);
      expect(s?.rotationRunsEstimate).toBe(20);
      expect(s?.rotationMsEstimate).toBe(20 * 86_400_000);
      expect(s?.rotationExceedsRetention).toBe(true);
      expect(s?.noBriefInWindow).toBe(false);

      expect(r.markdown).toContain("## sym (sweep: symbols)");
      expect(r.markdown).toContain("swept 14 of 40 subjects this window");
      expect(r.markdown).toContain("cannot report movement");
      expect(r.markdown).toContain("First observation: 12");
      expect(r.markdown).toContain("- … and 2 more");
      expect(r.markdown).toContain("### symbols:a");
    });

    test("a configured sweep with no brief in the window reports noBriefInWindow at JOB level", () => {
      const r = buildFleetDigest({ store, jobs: [SWEEP_JOB], windowMs: 1000, now: 5500, retentionDays: 14 });
      expect(r.sweeps[0]?.noBriefInWindow).toBe(true);
      expect(r.notCompared.noBriefInWindow).toEqual([]);
      expect(r.markdown).toContain("No brief in window: yes");
    });

    test("an UNCONFIGURED job whose briefs carry non-job subject keys is still grouped as a sweep", () => {
      insertBrief({
        jobId: "gone",
        subjectKey: "services:checkout",
        agentMethod: "agents.ghost",
        createdAt: 5000,
        findings: ghostFindings(["p1"]),
      });
      const r = buildFleetDigest({ store, jobs: [], windowMs: 1000, now: 5500, retentionDays: 14 });
      expect(r.sweeps[0]).toMatchObject({
        jobId: "gone",
        sweepKind: "services",
        configured: false,
        rotationRunsEstimate: null,
      });
      expect(r.markdown).toContain("[unconfigured]");
    });

    test("(red-prove) a fleet with no sweeps has an empty sweeps array and no sweep section", () => {
      insertBrief({ jobId: "j1", agentMethod: "agents.ghost", createdAt: 100, findings: ghostFindings(["p1"]) });
      insertBrief({ jobId: "j1", agentMethod: "agents.ghost", createdAt: 5000, findings: ghostFindings(["p2"]) });
      const r = buildFleetDigest({ store, jobs: [job("j1", "ghost")], windowMs: 1000, now: 5500, retentionDays: 14 });
      expect(r.sweeps).toEqual([]);
      expect(r.markdown).not.toContain("(sweep:");
      expect(r.markdown).toBe(
        renderFleetDigest({
          windowMs: r.windowMs,
          generatedAt: r.generatedAt,
          jobs: r.jobs,
          notCompared: r.notCompared,
          sweeps: [],
        }),
      );
    });

    test("the same database renders the same bytes twice, keys code-unit sorted", () => {
      brief("symbols:b", 5000, ["p1"]);
      brief("symbols:a", 5000, ["p1"]);
      const once = buildFleetDigest({ store, jobs: [SWEEP_JOB], windowMs: 1000, now: 5500, retentionDays: 14 });
      const twice = buildFleetDigest({ store, jobs: [SWEEP_JOB], windowMs: 1000, now: 5500, retentionDays: 14 });
      expect(once.markdown).toBe(twice.markdown);
      expect(once.sweeps[0]?.firstObservationKeys).toEqual(["symbols:a", "symbols:b"]);
    });
  });
```

The pre-existing golden Markdown expectations updated in Step 2 remain the primary byte-identity guard for config-named jobs.


- [ ] **Step 4: Run → FAIL**

Run: `bun test packages/gateway/src/fleet/fleet-digest.test.ts -t "sweep"`
Expected: FAIL.

- [ ] **Step 5: Implement the builder**

In `fleet/fleet-digest.ts` (imports: `SWEEP_KINDS`, `type SweepKind` from `../config/fleet-toml.ts`; the new types):

```ts
const DAY_MS = 86_400_000;
/** First-observation keys shown in Markdown before "… and N more". JSON carries all of them. */
const FIRST_OBSERVATION_SHOWN = 10;

function kindFromKey(key: string): SweepKind | null {
  const prefix = key.slice(0, key.indexOf(":"));
  return (SWEEP_KINDS as readonly string[]).includes(prefix) ? (prefix as SweepKind) : null;
}
```

(`prefix as SweepKind` is narrowed by the `includes` check on the same line; if Biome/Sonar flags the assertion, replace with a `find` over `SWEEP_KINDS` returning the element.)

```ts
function buildSweepDigest(
  deps: { store: FleetStore; now: number; retentionDays: number },
  jobId: string,
  cfg: NimbusFleetJobToml | undefined,
  windowStartMs: number,
): FleetSweepDigest {
  const keys = deps.store.subjectKeysWithBriefsInWindow({ jobId, windowStartMs, now: deps.now });
  const configured = cfg !== undefined;
  const minDelta = cfg?.digestMinDelta ?? 1;
  let agentMethod = cfg === undefined ? "unknown" : `agents.${cfg.agent}`;
  const moved: FleetSweepSubjectDigest[] = [];
  const firstObservationKeys: string[] = [];
  const notSummarizable: FleetDigestSubjectRef[] = [];
  const agentChanged: FleetDigestSubjectRef[] = [];
  let unchangedCount = 0;
  let unchangedWithinThresholdCount = 0;

  for (const subjectKey of keys) {
    const { current, predecessor } = deps.store.briefPairForSubject({
      jobId,
      subjectKey,
      windowStartMs,
      now: deps.now,
    });
    if (current === undefined) continue;
    agentMethod = current.agentMethod;
    if (predecessor === undefined) {
      firstObservationKeys.push(subjectKey);
      continue;
    }
    if (current.agentMethod !== predecessor.agentMethod) {
      agentChanged.push({
        subjectKey,
        briefId: current.id,
        reason: `${predecessor.agentMethod} → ${current.agentMethod}, not comparable`,
      });
      continue;
    }
    const after = summarizeBrief(current.agentMethod, current.findingsJson);
    const before = summarizeBrief(predecessor.agentMethod, predecessor.findingsJson);
    if (after === undefined || before === undefined) {
      if (after === undefined) {
        notSummarizable.push({ subjectKey, briefId: current.id, reason: `unreadable ${current.agentMethod} brief (current)` });
      }
      if (before === undefined) {
        notSummarizable.push({ subjectKey, briefId: predecessor.id, reason: `unreadable ${predecessor.agentMethod} brief (predecessor)` });
      }
      continue;
    }
    const compared = compareSummaries(before, after, minDelta);
    if (compared.status === "unchanged") {
      unchangedCount += 1;
      continue;
    }
    if (compared.status === "unchanged_within_threshold") {
      unchangedWithinThresholdCount += 1;
      continue;
    }
    moved.push({
      jobId,
      subjectKey,
      agentMethod: current.agentMethod,
      configured,
      minDelta,
      currentBriefId: current.id,
      currentCreatedAt: current.createdAt,
      predecessorBriefId: predecessor.id,
      predecessorCreatedAt: predecessor.createdAt,
      comparisonSpanMs: current.createdAt - predecessor.createdAt,
      ...compared,
    });
  }

  const subjectsTotal = deps.store.loadSweepState(jobId)?.subjectsTotal ?? null;
  const sweep = cfg?.sweep ?? null;
  const rotationRunsEstimate =
    subjectsTotal === null || sweep === null ? null : Math.ceil(subjectsTotal / sweep.maxSubjects);
  const rotationMsEstimate =
    rotationRunsEstimate === null || cfg === undefined
      ? null
      : rotationRunsEstimate * cfg.intervalSeconds * 1000;
  const retentionMs = deps.retentionDays * DAY_MS;
  const firstKey = keys.find((k) => k !== jobId);
  return {
    jobId,
    agentMethod,
    sweepKind: sweep?.kind ?? (firstKey === undefined ? null : kindFromKey(firstKey)),
    configured,
    subjectsTotal,
    subjectsSweptInWindow: keys.length,
    rotationRunsEstimate,
    rotationMsEstimate,
    retentionMs,
    rotationExceedsRetention: rotationMsEstimate !== null && rotationMsEstimate > retentionMs,
    moved,
    unchangedCount,
    unchangedWithinThresholdCount,
    firstObservationKeys,
    notSummarizable,
    agentChanged,
    noBriefInWindow: keys.length === 0,
  };
}
```

In `buildFleetDigest`: add `retentionDays: number` to `deps`. After computing `ids`, compute the sweep set:

```ts
  // A job is a sweep when its config says so, or — once removed from config — when a live brief in
  // the window carries a subject key other than its own job id (spec § 8.1).
  const sweepIds = new Set(
    ids.filter((id) => {
      const cfg = configured.get(id);
      if (cfg !== undefined) return cfg.sweep !== null;
      return deps.store
        .subjectKeysWithBriefsInWindow({ jobId: id, windowStartMs, now: deps.now })
        .some((k) => k !== id);
    }),
  );
```

At the top of the existing `for (const jobId of ids)` loop add `if (sweepIds.has(jobId)) continue;`. After the loop:

```ts
  const sweeps = [...sweepIds].map((id) => buildSweepDigest(deps, id, configured.get(id), windowStartMs));
```

`ids` is already `codeUnitCompare`-sorted, so `sweeps` is too. The `result` object gains `sweeps`.

- [ ] **Step 6: Implement the renderer**

Refactor `jobSection` so its body is shareable WITHOUT changing its output. Replace the whole existing `jobSection` function with these two, moving every existing comment with the line it describes:

```ts
/** One job's `## <id>` section: the heading, a blank line, then the shared body. Output unchanged. */
function jobSection(j: FleetJobDigest): string[] {
  return [`## ${mdSafe(j.jobId)}${unconfiguredMarker(j.configured)}`, "", ...jobBody(j)];
}

/** Everything under a job OR sweep-subject heading: summary line, withheld disclosure, table, churn. */
function jobBody(j: FleetJobDigest): string[] {
  const status =
    j.status === "unchanged_within_threshold"
      ? `unchanged within threshold (digest_min_delta = ${String(j.minDelta)})`
      : j.status;
  const out: string[] = [
    `${mdSafe(j.agentMethod)} · compared over ${humanDuration(j.comparisonSpanMs)} · ${status}`,
    "",
  ];
  if (j.metricsSuppressed > 0) {
    const n = j.metricsSuppressed;
    out.push(
      `${String(n)} metric${n === 1 ? "" : "s"} withheld below digest_min_delta = ${String(j.minDelta)}`,
      "",
    );
  }
  if (Object.keys(j.metrics).length > 0) {
    out.push("| metric | before | after | delta |", "| --- | --- | --- | --- |");
    const entries = Object.entries(j.metrics).sort((a, b) => codeUnitCompare(a[0], b[0]));
    for (const [n, delta] of entries) out.push(metricRow(n, delta));
    out.push("");
  }
  out.push(
    ...keyChurnLines("Appeared", j.keysAppeared),
    ...keyChurnLines("Resolved", j.keysResolved),
  );
  return out;
}
```

(The comments inside the original `jobSection` — the withheld-metric rationale and the `Object.entries` sort rationale — go above the corresponding lines in `jobBody`, verbatim.)


Add:

```ts
const ROTATION_EXCEEDS_RETENTION =
  "A full rotation takes longer than retention, so a subject's previous brief expires before it is " +
  "revisited — this sweep cannot report movement. Raise max_subjects, shorten interval_seconds, " +
  "or raise [fleet] retention_days.";

function coverageLine(s: FleetSweepDigest): string {
  const total = s.subjectsTotal === null ? "an unknown number of" : String(s.subjectsTotal);
  const rotation =
    s.rotationRunsEstimate === null || s.rotationMsEstimate === null
      ? "full rotation unknown"
      : `full rotation ≈ ${String(s.rotationRunsEstimate)} runs ≈ ${humanDuration(s.rotationMsEstimate)}`;
  return (
    `${mdSafe(s.agentMethod)} · swept ${String(s.subjectsSweptInWindow)} of ${total} subjects this window · ` +
    `${rotation} · retention ${humanDuration(s.retentionMs)}`
  );
}

/**
 * A sweep job's ONE section (spec § 8.1). Every outcome line is always written, including as an
 * explicit zero — the 2a rule that a section vanishing when empty trains a reader to stop looking.
 */
function sweepSection(s: FleetSweepDigest): string[] {
  const out: string[] = [
    `## ${mdSafe(s.jobId)} (sweep: ${s.sweepKind ?? "unknown"})${unconfiguredMarker(s.configured)}`,
    "",
    coverageLine(s),
    "",
  ];
  if (s.rotationExceedsRetention) out.push(ROTATION_EXCEEDS_RETENTION, "");
  const hidden = s.firstObservationKeys.length - FIRST_OBSERVATION_SHOWN;
  out.push(
    `Moved: ${String(s.moved.length)}`,
    `Unchanged: ${String(s.unchangedCount)}`,
    `Unchanged within digest_min_delta: ${String(s.unchangedWithinThresholdCount)}`,
    `First observation: ${String(s.firstObservationKeys.length)}`,
    ...s.firstObservationKeys.slice(0, FIRST_OBSERVATION_SHOWN).map((k) => `- ${mdSafe(k)}`),
    ...(hidden > 0 ? [`- … and ${String(hidden)} more`] : []),
    `Not summarizable: ${String(s.notSummarizable.length)}`,
    ...s.notSummarizable.map((e) => `- ${mdSafe(e.subjectKey)} — ${mdSafe(e.reason)}`),
    `Agent changed: ${String(s.agentChanged.length)}`,
    ...s.agentChanged.map((e) => `- ${mdSafe(e.subjectKey)} — ${mdSafe(e.reason)}`),
    `No brief in window: ${s.noBriefInWindow ? "yes" : "no"}`,
    "",
  );
  for (const m of s.moved) out.push(`### ${mdSafe(m.subjectKey)}`, "", ...jobBody(m));
  return out;
}
```

In `renderFleetDigest`, between `for (const j of d.jobs) out.push(...jobSection(j));` and `out.push(...notComparedSection(d.notCompared));` add `for (const s of d.sweeps) out.push(...sweepSection(s));`.

In `ipc/fleet-rpc.ts` `handleDigest`, pass `retentionDays: ctx.config.retentionDays` to `buildFleetDigest`.

- [ ] **Step 7: Run; red-prove; commit**

Run: `bun test packages/gateway/src/fleet packages/gateway/src/ipc/fleet-rpc.test.ts && bun run typecheck`
Expected: PASS, with EVERY pre-existing Markdown expectation unchanged.
**Red-prove** byte identity: temporarily emit `out.push("")` unconditionally after the sweeps loop in `renderFleetDigest`; confirm pre-existing golden tests FAIL; restore.
Commit: `feat(fleet): group sweep jobs in the digest, one section per sweep`

---

### Task 8: IPC and CLI surfaces

**Files:**
- Modify: `packages/gateway/src/ipc/fleet-rpc.ts`
- Test: `packages/gateway/src/ipc/fleet-rpc.test.ts`
- Modify: `packages/cli/src/commands/fleet.ts`
- Test: `packages/cli/src/commands/fleet.test.ts`

**Interfaces:**
- Consumes: `listBriefs({ subjectKey })`, `loadSweepState` (Task 2); `FleetJobSweepToml`, `SweepKind` (Task 3).
- Produces:
  - `export interface FleetJobSweepListEntry { readonly kind: SweepKind; readonly maxSubjects: number; readonly pathPrefix: string | null; readonly subjectsTotal: number | null; readonly cursor: string | null; readonly emptyReason: string | null }`
  - `FleetJobListEntry.sweep: FleetJobSweepListEntry | null`
  - `fleet.briefs` accepts `subjectKey` (non-empty string).
  - CLI: `FleetBriefsArgs.subject?: string`; `nimbus fleet briefs --subject <key>`.

- [ ] **Step 1: Failing RPC tests**

Add inside `describe("fleet.list / fleet.briefs / fleet.show over a real store", …)` in `ipc/fleet-rpc.test.ts`, which provides `store`, `jobs`, `ctx(now, over)` and a real in-memory schema:

```ts
  function seedBrief(jobId: string, subjectKey: string, createdAt: number): void {
    const runId = store.openRun({
      startedAt: createdAt,
      hostPower: "ac",
      hostIdleMs: 0,
      hostSource: "measured",
      remoteCallBudget: 0,
    });
    store.recordBrief({
      runId,
      jobId,
      subjectKey,
      agentMethod: "agents.oncall",
      briefMarkdown: "x",
      findingsJson: "{}",
      synthesisJson: null,
      createdAt,
      expiresAt: createdAt + 86_400_000,
    });
  }

  const sweepJob: NimbusFleetJobToml = {
    name: "bus",
    agent: "ownership",
    intervalSeconds: 86_400,
    params: {},
    digestMinDelta: 1,
    sweep: { kind: "paths", maxSubjects: 20, pathPrefix: "src/" },
  };

  test("fleet.briefs filters by subjectKey", async () => {
    seedBrief("nightly", "services:checkout", 1000);
    seedBrief("nightly", "services:billing", 1001);
    const r = await dispatchFleetRpc("fleet.briefs", { subjectKey: "services:checkout" }, ctx(2000));
    expect(r.kind).toBe("hit");
    const briefs = (r as { value: { briefs: Array<{ subjectKey: string }> } }).value.briefs;
    expect(briefs.map((b) => b.subjectKey)).toEqual(["services:checkout"]);
  });

  test("fleet.briefs refuses an empty subjectKey", async () => {
    await expect(dispatchFleetRpc("fleet.briefs", { subjectKey: "" }, ctx(2000))).rejects.toThrow(
      /subjectKey must be a non-empty string/,
    );
  });

  test("fleet.list reports sweep config and state; config-named jobs report sweep: null", async () => {
    store.recordSweepEnumeration("bus", { kind: "paths", subjectsTotal: 60, emptyReason: null });
    const r = await dispatchFleetRpc("fleet.list", {}, ctx(2000, { jobs: [...jobs, sweepJob] }));
    const listed = (r as { value: { jobs: Array<{ name: string; sweep: unknown }> } }).value.jobs;
    expect(listed.find((j) => j.name === "bus")?.sweep).toEqual({
      kind: "paths",
      maxSubjects: 20,
      pathPrefix: "src/",
      subjectsTotal: 60,
      cursor: null,
      emptyReason: null,
      // ceil(60 / 20) = 3 runs × 1 day = 3 days, inside the default 14-day retention
      rotationExceedsRetention: false,
    });
    expect(listed.find((j) => j.name === "morning_catchup")?.sweep).toBeNull();
  });

  test("fleet.list flags a rotation longer than retention, and null before any enumeration", async () => {
    type Listed = { value: { jobs: Array<{ sweep: { rotationExceedsRetention: unknown } }> } };
    const r1 = (await dispatchFleetRpc("fleet.list", {}, ctx(2000, { jobs: [sweepJob] }))) as Listed;
    expect(r1.value.jobs[0]?.sweep.rotationExceedsRetention).toBeNull();
    store.recordSweepEnumeration("bus", { kind: "paths", subjectsTotal: 400, emptyReason: null });
    const r2 = (await dispatchFleetRpc("fleet.list", {}, ctx(2000, { jobs: [sweepJob] }))) as Listed;
    expect(r2.value.jobs[0]?.sweep.rotationExceedsRetention).toBe(true); // 20 runs = 20 days > 14
  });
```


- [ ] **Step 2: Run → FAIL; implement RPC**

In `ipc/fleet-rpc.ts`:

```ts
export interface FleetJobSweepListEntry {
  readonly kind: SweepKind;
  readonly maxSubjects: number;
  readonly pathPrefix: string | null;
  /** From the last enumeration; null before the first. */
  readonly subjectsTotal: number | null;
  readonly cursor: string | null;
  readonly emptyReason: string | null;
  /**
   * Whether one full rotation (ceil(total / max) × interval) outlasts `[fleet] retention_days`, in
   * which case a subject's predecessor expires before it is revisited and the digest can never
   * report movement for this sweep (spec § 10). Null before the first enumeration.
   */
  readonly rotationExceedsRetention: boolean | null;
}
```

`FleetJobListEntry` gains `readonly sweep: FleetJobSweepListEntry | null;`. `handleList` maps:

```ts
    jobs: jobs.map((j) => {
      const state = ctx.store?.loadSweepState(j.name);
      const total = state?.subjectsTotal ?? null;
      return {
        name: j.name,
        agent: j.agent,
        intervalSeconds: j.intervalSeconds,
        state: ctx.store?.loadJobState(j.name) ?? null,
        sweep:
          j.sweep === null
            ? null
            : {
                kind: j.sweep.kind,
                maxSubjects: j.sweep.maxSubjects,
                pathPrefix: j.sweep.pathPrefix,
                subjectsTotal: total,
                cursor: state?.cursor ?? null,
                emptyReason: state?.emptyReason ?? null,
                rotationExceedsRetention:
                  total === null
                    ? null
                    : Math.ceil(total / j.sweep.maxSubjects) * j.intervalSeconds * 1000 >
                      ctx.config.retentionDays * 86_400_000,
              },
      };
    }),
```

`handleBriefs`: `const subjectKey = optString(params, "subjectKey");` and spread `...(subjectKey === undefined ? {} : { subjectKey })` into `listBriefs`. Update `handleList`'s doc comment: "Sweep progress lives here rather than on `fleet.status`, which never reads the store."

Run: `bun test packages/gateway/src/ipc/fleet-rpc.test.ts` → PASS.

- [ ] **Step 3: Failing CLI tests**

Add to `packages/cli/src/commands/fleet.test.ts`:

```ts
test("parses briefs --subject", () => {
  expect(parseFleetArgs(["briefs", "--subject", "paths:file:/r:a.ts"])).toEqual({
    sub: "briefs",
    subject: "paths:file:/r:a.ts",
    json: false,
  });
});

test("briefs sends subjectKey and shows a subject only when it differs from the job", async () => {
  const calls: Array<{ method: string; params: unknown }> = [];
  const out: string[] = [];
  const ipc: FleetIpc = {
    call: async (method, params) => {
      calls.push({ method, params });
      return {
        briefs: [
          { id: "b1", runId: "r", jobId: "nightly", subjectKey: "nightly", agentMethod: "agents.catchup", briefMarkdown: null, findingsJson: "{}", synthesisJson: null, createdAt: 0 },
          { id: "b2", runId: "r", jobId: "bus", subjectKey: "paths:a", agentMethod: "agents.ownership", briefMarkdown: null, findingsJson: "{}", synthesisJson: null, createdAt: 0 },
        ],
      };
    },
  };
  await runFleetCommand(ipc, { sub: "briefs", subject: "paths:a", json: false }, { out: (s) => out.push(s), err: () => {} });
  expect(calls[0]?.params).toEqual({ subjectKey: "paths:a" });
  expect(out[0]).toBe(`b1  nightly  agents.catchup  ${new Date(0).toISOString()}\n`);
  expect(out[1]).toBe(`b2  bus  [paths:a]  agents.ownership  ${new Date(0).toISOString()}\n`);
});

test("list shows sweep info and an empty reason", async () => {
  const out: string[] = [];
  const ipc: FleetIpc = {
    call: async () => ({
      jobs: [
        { name: "bus", agent: "ownership", intervalSeconds: 60, state: null, sweep: { kind: "paths", maxSubjects: 20, pathPrefix: null, subjectsTotal: 0, cursor: null, emptyReason: "no roots", rotationExceedsRetention: null } },
      ],
    }),
  };
  await runFleetCommand(ipc, { sub: "list", json: false }, { out: (s) => out.push(s), err: () => {} });
  expect(out.join("")).toContain("sweep=paths max=20 total=0");
  expect(out.join("")).toContain("empty: no roots");
});
```

Check `runFleetCommand`'s real signature (line 389) and adapt the call shape — do not change the function to fit the test.

- [ ] **Step 4: Run → FAIL; implement CLI**

In `packages/cli/src/commands/fleet.ts`:
- USAGE `briefs` line: `  briefs [--limit N] [--job ID] [--subject KEY]  list synthesised briefs, most recent first`
- `FleetBriefsArgs` gains `readonly subject?: string;`; `parseBriefsArgs` reads `flagValue(rest, "--subject")` and spreads it like `job`.
- `FleetBriefSummaryShape` gains `readonly subjectKey: string;`.
- `FleetJobListEntryShape` gains `readonly sweep: { readonly kind: string; readonly maxSubjects: number; readonly pathPrefix: string | null; readonly subjectsTotal: number | null; readonly cursor: string | null; readonly emptyReason: string | null } | null;`.
- `FleetRunSummaryShape` gains the three `subjects*` numbers.
- `FleetDigestResultShape` gains `readonly sweeps: readonly unknown[];`.
- `runBriefs`: `if (a.subject !== undefined) params["subjectKey"] = a.subject;` and the row line:

```ts
    // A config-named job's subject IS the job, so the column is shown only when it adds something —
    // which also keeps every pre-sweep output line byte-identical.
    const subject = b.subjectKey === b.jobId ? "" : `  [${b.subjectKey}]`;
    sink.out(`${b.id}  ${b.jobId}${subject}  ${b.agentMethod}  ${new Date(b.createdAt).toISOString()}\n`);
```

- `runList`: append to the per-job line, before the trailing `\n`:

```ts
    const sweep =
      j.sweep === null
        ? ""
        : `  sweep=${j.sweep.kind} max=${j.sweep.maxSubjects} total=${j.sweep.subjectsTotal ?? "?"}` +
          (j.sweep.emptyReason === null ? "" : `  empty: ${j.sweep.emptyReason}`) +
          (j.sweep.rotationExceedsRetention === true
            ? "  WARNING: a full rotation outlasts retention; this sweep cannot report movement"
            : "");
```

`FleetJobListEntryShape.sweep` also gains `readonly rotationExceedsRetention: boolean | null;`.

(interpolate `${sweep}` after `consecutive failures=${failures}`).

- [ ] **Step 5: Run and commit**

Run: `bun test packages/cli/src/commands/fleet.test.ts packages/cli/src/commands/help.test.ts packages/gateway/src/ipc/fleet-rpc.test.ts && bun run typecheck`
Expected: PASS (if `help.test.ts` pins the `nimbus help` fleet block, update that block in the help source to include `--subject`, not the test).
Commit: `feat(fleet): subject filter on fleet briefs and sweep state on fleet list`

---

### Task 9: Docs, full verification, and PR preparation

**Files:**
- Modify: `docs/architecture.md` (§ Spine S2 → fleet), `docs/roadmap.md`, `docs/cli-reference.md`, `docs/CHANGELOG.md`, `CLAUDE.md`, `GEMINI.md`

- [ ] **Step 1: Find every restatement**

```bash
rg -n "PR 2b|subject enumeration|names each job's subject|Subject enumeration" docs CLAUDE.md GEMINI.md .claude/commands
rg -n "schema V62|schema \*\*V62\*\*|through V62" docs CLAUDE.md GEMINI.md .claude/commands
rg -n "revisit in PR 2" packages/gateway/src
```

- [ ] **Step 2: Write the updates**

- `docs/architecture.md` § Spine S2 → fleet: the sweep design record — the `sweep` key, the four enumerators and their sources (§ 5.2), why `paths` enumerates ownership nodes rather than blame rows, why ghost/conflicts sweep symbols, the not-enumerable table with reasons (§ 5.3), the key cursor, V63, the digest grouping, the rejected architectures (§ 9), and every bound in § 10 (rotation vs. retention, symbol label collisions, eventual coverage).
- `docs/roadmap.md`: flip the fleet row's "PR 2b (subject enumeration) NOT shipped" at EVERY restatement to shipped (dated 2026-09-17 or the merge date), with § 10's bounds; keep `negotiate` deferred with the settled reason.
- `docs/cli-reference.md`: `[[fleet.job]]` `sweep`/`max_subjects`/`path_prefix` (types, bounds, refusals), `nimbus fleet briefs --subject`, `fleet list` sweep output.
- `docs/CHANGELOG.md`: a dated entry at the top of "Post-Phase-6 deliveries" in the file's style — what shipped, V63, the two review-found corrections (paths source, symbol label collisions), bounds, "no invariant, no egress class, no new IPC method".
- `CLAUDE.md` and `GEMINI.md`: the status paragraph's "NOT shipped: subject enumeration (PR 2b …)" sentence → shipped summary; `schema V62` → `schema V63`.

- [ ] **Step 3: Full local verification**

```bash
bun run preflight:fast
bun test packages/gateway/src/fleet packages/gateway/src/config/fleet-toml.test.ts packages/gateway/src/ipc/fleet-rpc.test.ts packages/gateway/src/index/migrations/runner.test.ts packages/cli/src/commands/fleet.test.ts
bun run typecheck:tests
bun run audit:platform-test-gaps
```

Expected: all pass. Fix every failure before continuing; do not claim done on a red gate.

- [ ] **Step 4: Commit docs**

Commit: `docs(fleet): record subject enumeration across architecture, roadmap, CLI reference and changelog`

- [ ] **Step 5: Strip spec and plan before the PR**

Specs and plans do not land on `main`. Before opening the PR:

```bash
git rm docs/superpowers/specs/2026-09-17-fleet-subject-enumeration-design.md \
       docs/superpowers/specs/2026-09-17-fleet-subject-enumeration-review.md \
       docs/superpowers/specs/2026-09-17-fleet-subject-enumeration-review-response.md \
       docs/superpowers/plans/2026-09-17-fleet-subject-enumeration.md \
       docs/superpowers/plans/2026-09-17-fleet-subject-enumeration-review.md \
       docs/superpowers/plans/2026-09-17-fleet-subject-enumeration-review-response.md
git commit -F <msgfile>   # "docs: strip the fleet subject enumeration spec and plan before merge"
git diff main --stat -- docs/superpowers   # must print nothing
```

Then run `bun run preflight:fast` once more (doc-refs must not point at the removed files) and open the PR with a `feat(fleet): …` title and a description carrying the reasoning (the squash commit is built from it).
